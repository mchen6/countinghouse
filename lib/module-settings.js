'use strict';
// Module settings: what a module declares, and what its values may be (the
// module-level configuration design, docs/superpowers/specs/
// 2026-11-18-module-level-configuration-and-install-design.md, section 4).
//
// In the module's package.json, beside `calls` and `permissions`:
//
//   "countinghouse": {"settings": {
//     "units": {"type": "enum", "values": ["metric", "imperial"], "default": "metric", "title": "Units"},
//     "defaultRepo": {"type": "string", "format": "repo", "title": "Default repository"}}}
//
// A small closed vocabulary, not JSON Schema (section 4.1). The main thread
// reads it from the package.json it pins (lib/manifest-pins.js), so a module
// that rewrites its file and restarts under supervision keeps the declaration
// it was loaded with.
//
//   parseDeclaration(pkg) -> {settings, problems, warnings}
//     settings: null (none declared) or a frozen, null-prototype map of
//     name -> frozen declaration; problems: [{at, message, fix}] by position
//     and field (any problem refuses the module: SETTINGS_DECLARATION_INVALID);
//     warnings: the validator's (a secret-looking name or title, a part's
//     `required`).
//   checkValue(decl, value, {net}) -> {ok: true, value} (the canonical
//     value) | {ok: false, code, reason}; the reason says what is allowed and
//     never carries the value.
//   effective(settings, stored, {net, fixed}) -> {values, notApplied,
//     warnings, refused, refusedBy}: the declared defaults, then the stored
//     values, then the ceiling's fixed ones; values frozen and
//     null-prototype, an unset setting absent; notApplied [{setting, code,
//     reason}]; refusedBy {code, setting} says what refused it.
//   fixedOf(ceiling, name) -> a trusted ceiling's fixed values for the
//     module (its moduleSettings, lib/settings-ceiling.js), or null.
//   unsetRequired(settings, values) -> the required settings left unset.
//   confirmRule(decl) -> 'on request' | 'confirm' (section 4.4).
//   FORMATS[name](text) -> the canonical text, or null. Each is linear: a
//     1024-character worst case is timed in validation 25.
//
// Settings are not secrets, and the vocabulary has no secret type: a value
// may be shown, logged by name, and set in conversation. A value is never
// written to a log or a notice by this file; reasons name the setting only.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const clientText = require('./client-text');
const options = require('./cli-options');
const {CountinghouseError} = require('./countinghouse-error');
const {declaredText} = require('./schema-safety');
// The settings file is the main thread's: it is read (storedFor) and its
// history written (stateFor) only there, through the settings tool, which
// this file requires on that use. A worker that loads this file (a
// validation worker, through lib/module-validator.js) takes only the
// declaration's rules, and never reaches the settings tool after its
// lockdown (#194's PR 1, sandbox 67): judged once, at load.
const mainThreadAtLoad = require('./thread-info').isMainThread === true;
const {hostAllowed} = require('./module-permissions');

const TYPES = Object.freeze(['string', 'integer', 'number', 'boolean', 'enum']);
const FIELDS = Object.freeze(['type', 'values', 'min', 'max', 'maxLength', 'format', 'default', 'required', 'confirm', 'title', 'description']);
const NAME = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const ENUM_VALUE = /^[A-Za-z0-9 _.:/@+-]{1,64}$/;
const MAX_SETTINGS = 32;
const MAX_ENUM = 64;
const MAX_TITLE = 64;
const MAX_DESCRIPTION = 512;
const MAX_LENGTH = 1024;
const DEFAULT_MAX_LENGTH = 256;
const MAX_DECLARATION_BYTES = 16 * 1024;
const MAX_VALUES_BYTES = 32 * 1024;
// npm's grammar for a package name: lowercase, URL-safe, at most 214, not
// starting with . or _, an optional @scope/
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
// a name or title that looks like a secret: settings are not one (section 6)
const SECRET_LIKE = /password|passwd|token|secret|api[-_ ]?key|credential/i;

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const codePoints = (s) => { let n = 0; for (const _ of s) n += 1; return n; };

// ---- the formats: each linear, on text already at most MAX_LENGTH ----------

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function hostname(text) {
  if (typeof(text) !== 'string' || text.length === 0 || text.length > 253) return null;
  const lower = text.toLowerCase();
  const labels = lower.split('.');
  for (let i = 0; i < labels.length; i++) if (!LABEL.test(labels[i])) return null;
  return lower;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const slug = (text) => (typeof(text) === 'string' && SLUG.test(text)) ? text : null;

// GitHub: an owner of 1 to 39 letters, digits and single inner hyphens; a
// repository of 1 to 100 of [A-Za-z0-9._-], not . or ..
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
function repo(text) {
  if (typeof(text) !== 'string' || text.length > 140) return null;
  const slash = text.indexOf('/');
  if (slash === -1 || text.indexOf('/', slash + 1) !== -1) return null;
  const owner = text.slice(0, slash);
  const name = text.slice(slash + 1);
  if (!OWNER.test(owner) || !REPO_NAME.test(name) || name === '.' || name === '..') return null;
  return text;
}

const LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
function email(text) {
  if (typeof(text) !== 'string' || text.length > 254) return null;
  const at = text.lastIndexOf('@');
  if (at <= 0) return null;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (!LOCAL.test(local) || domain.indexOf('.') === -1) return null;
  return hostname(domain) === domain.toLowerCase() && hostname(domain) != null ? text : null;
}

function url(text) {
  if (typeof(text) !== 'string' || text.length > MAX_LENGTH) return null;
  let u = null;
  try { u = new URL(text); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || hostname(u.hostname) == null) return null;
  return u.href;
}

const FORMATS = Object.freeze({slug, repo, email, hostname, url});

// ---- a value ----------------------------------------------------------------

const refusal = (code, reason) => ({ok: false, code, reason});
const invalid = (reason) => refusal('SETTING_INVALID', reason);

function allowedText(decl) {
  switch (decl.type) {
    case 'enum': return decl.values.length === 1 ? decl.values[0] : `${decl.values.slice(0, -1).join(', ')} or ${decl.values[decl.values.length - 1]}`;
    case 'boolean': return 'true or false';
    case 'integer':
    case 'number': {
      const kind = decl.type === 'integer' ? 'a whole number' : 'a number';
      if (decl.min != null && decl.max != null) return `${kind} from ${decl.min} to ${decl.max}`;
      if (decl.min != null) return `${kind} of at least ${decl.min}`;
      if (decl.max != null) return `${kind} of at most ${decl.max}`;
      return kind;
    }
    default: return decl.format != null ? `${decl.format === 'url' ? 'an https URL' : `a ${decl.format}`} of at most ${decl.maxLength} characters` : `text of at most ${decl.maxLength} characters`;
  }
}

// inside the module's granted net (its permissions as the operator's policy
// narrowed them): a hostname by its host, a URL by its host and port
function insideNet(decl, value, net) {
  if (decl.format === 'hostname') return Array.isArray(net) && net.some((e) => e != null && hostAllowed([{host: e.host, ports: null}], value, null));
  if (decl.format === 'url') {
    const u = new URL(value);
    return hostAllowed(net, u.hostname, u.port === '' ? 443 : Number(u.port));
  }
  return true;
}

function checkValue(decl, value, {net = null} = {}) {
  const want = () => invalid(`${decl.name} is ${allowedText(decl)}`);
  switch (decl.type) {
    case 'boolean': return typeof(value) === 'boolean' ? {ok: true, value} : want();
    case 'integer':
    case 'number': {
      if (typeof(value) !== 'number' || !Number.isFinite(value) || (decl.type === 'integer' && !Number.isInteger(value))) return want();
      if ((decl.min != null && value < decl.min) || (decl.max != null && value > decl.max)) return want();
      return {ok: true, value};
    }
    case 'enum': return (typeof(value) === 'string' && decl.values.includes(value)) ? {ok: true, value} : want();
    default: {
      if (typeof(value) !== 'string' || value.length > decl.maxLength * 2) return want();
      if (clientText.hasHidden(value)) return invalid(`${decl.name} holds a hidden character, which a setting's value may not`);
      if (codePoints(value) > decl.maxLength) return want();
      let v = value;
      if (decl.format != null) {
        v = FORMATS[decl.format](value);
        if (v == null || codePoints(v) > decl.maxLength) return want();
        if ((decl.format === 'hostname' || decl.format === 'url') && !insideNet(decl, v, net)) {
          return refusal('SETTING_OUT_OF_BOUNDS', `${decl.name} is outside what the operator granted this module (its permissions.net)`);
        }
      }
      return {ok: true, value: v};
    }
  }
}

// ---- the declaration ----------------------------------------------------------

// A problem's position and message hold the module's own text (a field's or
// a setting's name): cleaned as declared text, as every validator stage's,
// so nothing in them reaches a terminal or a log as a control sequence.
const cleanProblem = (at, message, fix) => ({at: declaredText(at), message: declaredText(message), fix});

function parseOne(name, d, problems) {
  const at = (field) => `countinghouse.settings.${name}${field != null ? `.${field}` : ''}`;
  const bad = (field, message, fix) => problems.push(cleanProblem(at(field), message, fix));
  if (!isObject(d)) { bad(null, 'a setting is an object', 'declare it as {"type": ..., ...}'); return null; }
  for (const k of Object.keys(d)) {
    if (!FIELDS.includes(k)) bad(k, `"${k.slice(0, 64)}" is not a setting field`, `use only ${FIELDS.join(', ')} (there is no pattern and no path in release 1)`);
  }
  if (!TYPES.includes(d.type)) { bad('type', 'type is one of string, integer, number, boolean, enum', 'set "type" to one of them'); return null; }
  const out = {name, type: d.type};
  const numeric = d.type === 'integer' || d.type === 'number';
  if (d.type === 'enum') {
    const v = d.values;
    if (!Array.isArray(v) || v.length < 1 || v.length > MAX_ENUM || !v.every((x) => typeof(x) === 'string' && ENUM_VALUE.test(x)) || new Set(v).size !== v.length) {
      bad('values', `an enum's values are 1 to ${MAX_ENUM} distinct strings, each 1 to 64 characters of letters, digits, space and _.:/@+-`, 'list the allowed values');
    } else out.values = Object.freeze(v.slice());
  } else if (own(d, 'values')) bad('values', 'values is for an enum only', 'remove it, or make the type enum');
  for (const k of ['min', 'max']) {
    if (!own(d, k)) continue;
    if (!numeric) { bad(k, `${k} is for an integer or a number only`, `remove ${k}`); continue; }
    if (typeof(d[k]) !== 'number' || !Number.isFinite(d[k]) || (d.type === 'integer' && !Number.isInteger(d[k]))) {
      bad(k, `${k} is a finite ${d.type === 'integer' ? 'whole number' : 'number'}`, `give ${k} as a number`);
      continue;
    }
    out[k] = d[k];
  }
  if (out.min != null && out.max != null && out.min > out.max) bad('max', 'max is at least min', 'swap them, or widen the range');
  if (own(d, 'maxLength')) {
    if (d.type !== 'string') bad('maxLength', 'maxLength is for a string only', 'remove it');
    else if (!Number.isInteger(d.maxLength) || d.maxLength < 1 || d.maxLength > MAX_LENGTH) bad('maxLength', `maxLength is a whole number from 1 to ${MAX_LENGTH}`, `give a maxLength within 1 to ${MAX_LENGTH}`);
    else out.maxLength = d.maxLength;
  }
  if (d.type === 'string' && out.maxLength == null) out.maxLength = DEFAULT_MAX_LENGTH;
  if (own(d, 'format')) {
    if (d.type !== 'string') bad('format', 'format is for a string only', 'remove it');
    else if (!own(FORMATS, d.format)) bad('format', `format is one of ${Object.keys(FORMATS).join(', ')}`, 'use one of them, or leave the text open');
    else out.format = d.format;
  }
  for (const k of ['required', 'confirm']) {
    if (!own(d, k)) continue;
    if (typeof(d[k]) !== 'boolean') bad(k, `${k} is true or false`, `give ${k} as a boolean`);
    else if (d[k] === true) out[k] = true;
  }
  for (const [k, max] of [['title', MAX_TITLE], ['description', MAX_DESCRIPTION]]) {
    if (!own(d, k)) continue;
    if (typeof(d[k]) !== 'string' || d[k].length === 0 || d[k].length > max) bad(k, `${k} is text of 1 to ${max} characters`, `shorten the ${k}`);
    else out[k] = d[k];
  }
  if (own(d, 'default') && d.type === 'string' && d.default === '') {
    // an empty string is unset (section 4.1): no default, whatever the format
    out.default = '';
  } else if (own(d, 'default') && problems.every((p) => !p.at.startsWith(`${at(null)}.`) && p.at !== at(null))) {
    // the default checked as a value, with no net: a grant is the operator's,
    // checked at load (effective)
    const c = checkValue(out, d.default, {net: null});
    if (!c.ok && c.code !== 'SETTING_OUT_OF_BOUNDS') bad('default', `the default is not a valid value: ${c.reason}`, 'give a default the declaration accepts, or none');
    else out.default = d.default;
  }
  return Object.freeze(out);
}

// whether a package declares settings (the cheap check before any of it)
const declaresSettings = (pkg) => isObject(pkg) && isObject(pkg.countinghouse) && own(pkg.countinghouse, 'settings');

function parseDeclaration(pkg) {
  const problems = [];
  const warnings = [];
  const ch = isObject(pkg) && isObject(pkg.countinghouse) ? pkg.countinghouse : null;
  const declared = ch != null && own(ch, 'settings') ? ch.settings : undefined;
  if (declared === undefined) return {settings: null, problems, warnings};
  if (!isObject(declared)) {
    problems.push({at: 'countinghouse.settings', message: 'settings is an object of setting name to its declaration', fix: 'declare {"<name>": {"type": ...}}'});
    return {settings: null, problems, warnings};
  }
  const names = Object.keys(declared);
  if (names.length === 0) return {settings: null, problems, warnings};
  if (typeof(pkg.name) !== 'string' || pkg.name.length > 214 || !NPM_NAME.test(pkg.name)) {
    problems.push({at: 'name', message: 'a module that declares settings has an npm package name (lowercase, URL-safe, at most 214)', fix: 'give package.json a valid npm "name"'});
  }
  if (names.length > MAX_SETTINGS) problems.push({at: 'countinghouse.settings', message: `at most ${MAX_SETTINGS} settings per module`, fix: 'declare fewer settings'});
  if (Buffer.byteLength(JSON.stringify(declared), 'utf8') > MAX_DECLARATION_BYTES) {
    problems.push({at: 'countinghouse.settings', message: 'the settings declaration is at most 16 KiB', fix: 'shorten the descriptions, or declare fewer settings'});
  }
  const settings = Object.create(null);
  for (const name of names) {
    if (!NAME.test(name) || name in Object.prototype) {
      problems.push(cleanProblem(`countinghouse.settings[${JSON.stringify(name.slice(0, 80))}]`,
        'a setting name is a letter a-z then up to 63 letters, digits or _, with no dot, and not the name of an Object.prototype member',
        'rename the setting'));
      continue;
    }
    const one = parseOne(name, declared[name], problems);
    if (one != null) settings[name] = one;
  }
  const isPart = ch.role === 'part';
  for (const name of Object.keys(settings)) {
    const d = settings[name];
    if (SECRET_LIKE.test(name) || (d.title != null && SECRET_LIKE.test(d.title))) {
      warnings.push(`setting ${name} looks like a secret: settings are not secret (shown, set in conversation); declare a credential for a key instead`);
    }
    if (isPart && d.required === true) {
      warnings.push(`setting ${name} is required, but this module is a part: its settings are never named to a client, so a call through it fails until the user sets it at a terminal`);
    }
  }
  return {settings: problems.length === 0 ? Object.freeze(settings) : null, problems, warnings};
}

// ---- the effective values --------------------------------------------------

// a stored value's SHA-256 (of its JSON): whether a value not applied is the
// same one again, without keeping the value
const digestOf = (v) => crypto.createHash('sha256').update(String(JSON.stringify(v))).digest('hex');

function effective(settings, stored, {net = null, fixed = null, module = null} = {}) {
  const values = Object.create(null);
  const notApplied = [];
  const warnings = [];
  if (settings == null) return {values: Object.freeze(values), notApplied, warnings, refused: null};
  for (const name of Object.keys(settings)) {
    const d = settings[name];
    // no default, or an empty string, is unset
    if (!own(d, 'default') || d.default === '') continue;
    const c = checkValue(d, d.default, {net});
    if (c.ok) values[name] = c.value;
    else warnings.push(`setting ${name}'s default is outside what the operator granted (${c.reason}); it is unset`);
  }
  if (isObject(stored)) {
    for (const name of Object.keys(stored)) {
      const v = stored[name];
      if (!own(settings, name)) { notApplied.push({setting: name, code: 'SETTING_UNKNOWN', reason: 'not declared by this version', digest: digestOf(v)}); continue; }
      if (v === '' && settings[name].type === 'string') { delete values[name]; continue; }
      const c = checkValue(settings[name], v, {net});
      if (c.ok) values[name] = c.value;
      else notApplied.push({setting: name, code: c.code, reason: c.reason, digest: digestOf(v)});
    }
  }
  if (isObject(fixed)) {
    for (const name of Object.keys(fixed)) {
      // a name this version does not declare fails closed: a typo, or a
      // version that renamed the setting, would otherwise run with the
      // user's value while the operator believes it fixed
      if (!own(settings, name)) {
        const entry = (module != null) ? `${module}.${keyText(name)}` : keyText(name);
        return {values: null, notApplied, warnings, refused: `the operator's ceiling fixes moduleSettings "${entry}", which this version does not declare; update the ceiling`,
          refusedBy: {code: 'SETTING_UNKNOWN', setting: name, ceiling: true}};
      }
      if (fixed[name] === '' && settings[name].type === 'string') { delete values[name]; continue; }
      const c = checkValue(settings[name], fixed[name], {net});
      if (!c.ok) {
        return {values: null, notApplied, warnings, refused: `the operator's ceiling fixes ${name} to a value this module does not accept (${c.reason})`,
          refusedBy: {code: c.code, setting: name, ceiling: true}};
      }
      values[name] = c.value;
    }
  }
  if (Buffer.byteLength(JSON.stringify(values), 'utf8') > MAX_VALUES_BYTES) {
    return {values: null, notApplied, warnings, refused: 'its settings\' values are over 32 KiB together', refusedBy: {code: 'SETTING_INVALID', setting: null}};
  }
  return {values: Object.freeze(values), notApplied, warnings, refused: null};
}

function unsetRequired(settings, values) {
  if (settings == null) return [];
  return Object.keys(settings).filter((name) => settings[name].required === true && (values == null || !own(values, name)));
}

// The load's refusal for an invalid declaration, or null: the module and
// its first problem by position (the module's own text, cleaned as declared
// text and cut), and how many there are.
function declarationRefusal(pkg, name, problems = parseDeclaration(pkg).problems) {
  if (problems.length === 0) return null;
  // (each problem's text is cleaned where it is made: cleanProblem)
  let first = `${problems[0].at}: ${problems[0].message}`;
  if (first.length > 200) first = `${first.slice(0, 200)}…`;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more; countinghouse-validate lists them)` : '';
  return CountinghouseError.withFields('SETTINGS_DECLARATION_INVALID', {module: String(name), problem: `${first}${more}`});
}

// ---- the values a worker runs with ------------------------------------------

// Where a module's stored values come from: ch-local's settings file
// (--settingsFile, the single-identity profile: `module.<package>.<setting>`,
// the last dot splitting the setting from the package name), or an
// operator's --moduleSettings (`{"<package>": {"<setting>": value}}`, never
// written by the runtime), or nowhere. -> {stored, from, problem}
// `given`: the file's values, read once by the caller (reread), else null.
function storedFor(name, given = null) {
  if (options.settingsFile != null) {
    // read as the settings tool reads it (the same rules: one reader of the file)
    let raw = isObject(given) ? given : null;
    if (raw == null && !mainThreadAtLoad) return {stored: null, from: 'settingsFile', problem: 'the settings file is read on the main thread only'};
    if (raw == null) {
      try { raw = require('./settings-tool').readFile(options.settingsFile).raw; } catch (e) {
        return {stored: null, from: 'settingsFile', problem: e.message};
      }
    }
    const prefix = `module.${name}.`;
    const stored = Object.create(null);
    for (const key of Object.keys(raw)) {
      if (!key.startsWith(prefix)) continue;
      const setting = key.slice(prefix.length);
      if (setting.length > 0 && setting.indexOf('.') === -1) stored[setting] = raw[key];
    }
    return {stored, from: 'settingsFile', problem: null};
  }
  if (options.moduleSettings != null) {
    const read = readModuleSettings(options.moduleSettings);
    if (read.problem != null) return {stored: null, from: 'moduleSettings', problem: read.problem};
    const stored = Object.create(null);
    if (own(read.byModule, name)) for (const k of Object.keys(read.byModule[name])) stored[k] = read.byModule[name][k];
    return {stored, from: 'moduleSettings', problem: null};
  }
  return {stored: Object.create(null), from: null, problem: null};
}

// --moduleSettings <file>: {"<package>": {"<setting>": value}}, read at each
// load (and checked once at start, framework.js). -> {byModule, problem}
function readModuleSettings(file) {
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    return {byModule: null, problem: `--moduleSettings ${e.code != null ? `cannot be read (${e.code})` : 'is not JSON'}`};
  }
  if (!isObject(parsed) || !Object.keys(parsed).every((k) => isObject(parsed[k]))) {
    return {byModule: null, problem: '--moduleSettings is an object of {"<package>": {"<setting>": value}}'};
  }
  return {byModule: parsed, problem: null};
}

// A value kept in a history line: as stored, or cut to 64 characters with the
// SHA-256 of the whole (its JSON) beside it.
function keptOf(value) {
  const text = typeof(value) === 'string' ? value : JSON.stringify(value);
  if (text == null || text.length <= 64) return {kept: value};
  return {kept: text.slice(0, 64), keptSha256: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}

// A trusted ceiling's fixed values for module `name` (lib/settings-ceiling.js
// parse: moduleSettings.byModule), as a null-prototype map, or null. The
// ceiling is read by the caller, on the main thread (this file is a
// validation worker's too, and reads no ceiling).
function fixedOf(ceiling, name) {
  const m = (ceiling != null && ceiling.state === 'trusted' && ceiling.ceiling != null) ? ceiling.ceiling.moduleSettings : null;
  const rules = (m != null && m.byModule != null && own(m.byModule, name)) ? m.byModule[name] : null;
  if (rules == null) return null;
  const out = Object.create(null);
  for (const s of Object.keys(rules)) if (isObject(rules[s]) && own(rules[s], 'fixed')) out[s] = rules[s].fixed;
  return Object.keys(out).length > 0 ? out : null;
}

// Every state a worker runs with is numbered: a later one, a higher version
// (the invoke message carries the version, the values once per worker).
let versions = 0;

// The settings a worker of module `name` runs with, from its pinned
// package.json (`pkg`): {settings, values, version, refused}. `net`: the
// module's granted net (its permissions as the operator's policy narrowed
// them). `operator`: an operator's load, reload or restart (a supervised
// restart is not). The log says a stored value not applied at every load;
// the history says it once per value in this runtime. Under
// --moduleSettings a required setting the file leaves unset refuses the
// load, for the operator. `dryRun`: the refusal alone, nothing logged,
// written or numbered (an operator's load, checked before anything is
// unloaded: ModuleManager.prototype.stateRefusal). `last`: the state this
// module ran with before; a supervised restart whose settings file cannot
// be read now keeps it rather than staying down. `ceiling`: the operator's
// ceiling as the caller read it (lib/settings-ceiling.js readCeiling's
// result), or null where none binds: a trusted one's fixed values are
// applied over the file's, and one that cannot be trusted refuses an
// operator's load of a module that declares settings (a supervised restart
// keeps what it ran with, as for a file that cannot be read). `raw`: the
// settings file's values, read once by the caller (reread, for every
// module), else read here. `history`: false writes no history line (reread
// writes its own).
// -> {settings, values, version, refused, refusedBy, refusedWhy, notApplied}:
// refusedBy {code, setting} says what refused it, refusedWhy in words (never
// a value); notApplied [{setting, code, reason, digest}] the stored values
// that were not applied. A state made carries what it was made from (made:
// {pkg, net}, not enumerable), for reread.
function stateFor(name, pkg, {net = null, operator = false, log = () => {}, dryRun = false, last = null, ceiling = null, raw = null, history = true} = {}) {
  const none = {settings: null, values: null, version: null, refused: null, refusedBy: null, refusedWhy: null, notApplied: []};
  const declared = parseDeclaration(pkg);
  if (declared.problems.length > 0) {
    return Object.assign({}, none, {refused: declarationRefusal(pkg, name, declared.problems), refusedBy: {code: 'SETTINGS_DECLARATION_INVALID', setting: null}});
  }
  if (declared.settings == null) return none;
  const refused = (why, by) => Object.assign({}, none, {refused: new CountinghouseError('LOAD_MODULE_FAIL', name, `its settings: ${why}`), refusedBy: by, refusedWhy: why});
  const source = storedFor(name, raw);
  let stored = source.stored;
  let problem = source.problem;
  let problemBy = {code: 'SETTING_NOT_APPLIED', setting: null};
  if (problem == null && ceiling != null && ceiling.state !== 'none' && ceiling.state !== 'trusted') {
    // what it fixes is not known: fail closed
    problem = `the operator's ceiling cannot be trusted (${String(ceiling.problem).slice(0, 200)})`;
    problemBy = {code: 'SETTING_CEILING_UNTRUSTED', setting: null};
  }
  if (problem != null) {
    if (operator !== true && dryRun !== true && last != null && last.values != null) {
      // the values it ran with, checked again against the net granted now
      // (the policy is read at each spawn): one outside it is unset
      log(`module settings: ${name}: ${problem}; its restart keeps the values it ran with`);
      stored = Object.assign(Object.create(null), last.values);
    } else {
      return refused(problem, problemBy);
    }
  }
  const e = effective(declared.settings, stored, {net, fixed: fixedOf(ceiling, name), module: name});
  if (e.refused != null) return refused(e.refused, e.refusedBy);
  if (source.from === 'moduleSettings' || (source.problem != null && options.moduleSettings != null)) {
    const unset = unsetRequired(declared.settings, e.values);
    if (unset.length > 0) return refused(`required setting${unset.length > 1 ? 's' : ''} ${unset.join(', ')} unset in --moduleSettings`, {code: 'SETTING_REQUIRED', setting: unset[0]});
  }
  if (dryRun === true) return Object.assign({}, none, {settings: declared.settings, notApplied: e.notApplied});
  for (const w of e.warnings) log(`module settings: ${name}: ${w}`);
  for (const n of e.notApplied) log(`module settings: ${name}: setting ${keyText(n.setting)} not applied: ${n.reason}`);
  if (history === true && operator === true && source.from === 'settingsFile') {
    const version = isObject(pkg) && typeof(pkg.version) === 'string' ? pkg.version : 'this version';
    for (const n of e.notApplied) {
      const kept = keptOf(stored[n.setting]);
      const once = `${options.settingsFile}\0${name}\0${n.setting}\0${version}\0${JSON.stringify(kept)}`;
      if (historyWritten.has(once)) continue;
      if (historyLine(name, n.setting, `no longer valid for ${version}`, {stored: stored[n.setting], log})) historyWritten.add(once);
    }
  }
  versions += 1;
  const st = {settings: declared.settings, values: e.values, version: versions, refused: null, refusedBy: null, refusedWhy: null, notApplied: e.notApplied};
  Object.defineProperty(st, 'made', {value: Object.freeze({pkg, net})});
  return st;
}
// a not-applied value's history line, once per value in this runtime
const historyWritten = new Set();
// A "not applied" line in the history beside --settingsFile, by the runtime,
// for module `name`'s setting (null: the module's): the load's and reread's
// (lib/settings-reread.js) one writer. {stored}: the user's value it is
// about, kept as stored or cut with its SHA-256; {ceiling}: the operator's
// ceiling is what refused it (its words in `problem`), so no stored value is
// blamed. Main thread only. -> whether it was written.
function historyLine(name, setting, change, {stored, ceiling = null, log = () => {}} = {}) {
  if (options.settingsFile == null || !mainThreadAtLoad) return false;
  const file = path.join(path.dirname(options.settingsFile), 'history.jsonl');
  const key = setting != null ? `module.${name}.${keyText(setting)}` : `module.${name}`;
  const line = Object.assign({by: 'runtime', setting: key, change}, ceiling != null ? {problem: String(ceiling).slice(0, 200)} : (stored !== undefined ? keptOf(stored) : {}));
  try {
    require('./settings-tool').appendHistoryLine(file, line);
    return true;
  } catch (err) {
    log(`module settings: ${name}: the history line could not be written (${err.code || err.message})`);
    return false;
  }
}
// a stored key as said in the log and history: the settings file's text, a
// name this module may not declare, cleaned as declared text and cut to 64
const keyText = (key) => { const t = declaredText(String(key)); return t.length > 64 ? `${t.slice(0, 64)}…` : t; };

// How a user changes the setting in conversation (section 4.4): a part's
// settings are never named to a client, so set at a terminal only.
const confirmRule = (decl, {part = false} = {}) => {
  if (part === true) return 'terminal only';
  return (decl.confirm === true || decl.type === 'string') ? 'confirm' : 'on request';
};

module.exports = {NAME, declaresSettings, parseDeclaration, declarationRefusal, stateFor, fixedOf, historyLine, readModuleSettings, checkValue, effective, unsetRequired, confirmRule, FORMATS,
  MAX_SETTINGS, MAX_DECLARATION_BYTES, MAX_VALUES_BYTES};
