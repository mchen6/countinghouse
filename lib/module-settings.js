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
//     warnings, refused}: the declared defaults, then the stored values, then
//     the ceiling's fixed ones; values frozen and null-prototype, an unset
//     setting absent.
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

function parseOne(name, d, problems) {
  const at = (field) => `countinghouse.settings.${name}${field != null ? `.${field}` : ''}`;
  const bad = (field, message, fix) => problems.push({at: at(field), message, fix});
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
  if (own(d, 'default') && problems.every((p) => !p.at.startsWith(`${at(null)}.`) && p.at !== at(null))) {
    // the default checked as a value, with no net: a grant is the operator's,
    // checked at load (effective)
    const c = checkValue(out, d.default, {net: null});
    if (!c.ok && c.code !== 'SETTING_OUT_OF_BOUNDS') bad('default', `the default is not a valid value: ${c.reason}`, 'give a default the declaration accepts, or none');
    else out.default = d.default;
  }
  return Object.freeze(out);
}

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
      problems.push({at: `countinghouse.settings[${JSON.stringify(name.slice(0, 80))}]`,
        message: 'a setting name is a letter a-z then up to 63 letters, digits or _, with no dot, and not the name of an Object.prototype member',
        fix: 'rename the setting'});
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

function effective(settings, stored, {net = null, fixed = null} = {}) {
  const values = Object.create(null);
  const notApplied = [];
  const warnings = [];
  if (settings == null) return {values: Object.freeze(values), notApplied, warnings, refused: null};
  for (const name of Object.keys(settings)) {
    const d = settings[name];
    if (!own(d, 'default')) continue;
    const c = checkValue(d, d.default, {net});
    if (c.ok) values[name] = c.value;
    else warnings.push(`setting ${name}'s default is outside what the operator granted (${c.reason}); it is unset`);
  }
  if (isObject(stored)) {
    for (const name of Object.keys(stored)) {
      const v = stored[name];
      if (!own(settings, name)) { notApplied.push({setting: name, reason: 'not declared by this version'}); continue; }
      if (v === '' && settings[name].type === 'string') { delete values[name]; continue; }
      const c = checkValue(settings[name], v, {net});
      if (c.ok) values[name] = c.value;
      else notApplied.push({setting: name, reason: c.reason});
    }
  }
  if (isObject(fixed)) {
    for (const name of Object.keys(fixed)) {
      const c = own(settings, name) ? checkValue(settings[name], fixed[name], {net}) : invalid(`${name} is not declared by this version`);
      if (!c.ok) return {values: null, notApplied, warnings, refused: `the operator's ceiling fixes ${name} to a value this module does not accept (${c.reason})`};
      values[name] = c.value;
    }
  }
  if (Buffer.byteLength(JSON.stringify(values), 'utf8') > MAX_VALUES_BYTES) {
    return {values: null, notApplied, warnings, refused: 'its settings\' values are over 32 KiB together'};
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
function declarationRefusal(pkg, name) {
  const {problems} = parseDeclaration(pkg);
  if (problems.length === 0) return null;
  let first = declaredText(`${problems[0].at}: ${problems[0].message}`);
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
function storedFor(name) {
  if (options.settingsFile != null) {
    let text = null;
    try { text = fs.readFileSync(options.settingsFile, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return {stored: {}, from: 'settingsFile', problem: null};
      return {stored: null, from: 'settingsFile', problem: `the settings file cannot be read (${e.code})`};
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { return {stored: null, from: 'settingsFile', problem: 'the settings file is not JSON'}; }
    const values = (isObject(parsed) && isObject(parsed.values)) ? parsed.values : (isObject(parsed) && parsed.version == null ? {} : null);
    if (values == null) return {stored: null, from: 'settingsFile', problem: 'the settings file is not a version 1 settings file'};
    const prefix = `module.${name}.`;
    const stored = {};
    for (const key of Object.keys(values)) {
      if (!key.startsWith(prefix)) continue;
      const setting = key.slice(prefix.length);
      if (setting.length > 0 && setting.indexOf('.') === -1) stored[setting] = values[key];
    }
    return {stored, from: 'settingsFile', problem: null};
  }
  if (options.moduleSettings != null) {
    const read = readModuleSettings(options.moduleSettings);
    if (read.problem != null) return {stored: null, from: 'moduleSettings', problem: read.problem};
    return {stored: own(read.byModule, name) ? read.byModule[name] : {}, from: 'moduleSettings', problem: null};
  }
  return {stored: {}, from: null, problem: null};
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

// Every state a worker runs with is numbered: a later one, a higher version
// (the invoke message carries the version, the values once per worker).
let versions = 0;

// The settings a worker of module `name` runs with, from its pinned
// package.json (`pkg`): {settings, values, version, refused}. `net`: the
// module's granted net (its permissions as the operator's policy narrowed
// them). `operator`: an operator's load, reload or restart (a supervised
// restart is not): a stored value not applied is written to the history
// once, then; the log says it at every load. Under --moduleSettings a
// required setting the file leaves unset refuses the load, for the operator.
function stateFor(name, pkg, {net = null, operator = false, log = () => {}} = {}) {
  const none = {settings: null, values: null, version: null, refused: null};
  const declared = parseDeclaration(pkg);
  if (declared.problems.length > 0) return Object.assign({}, none, {refused: declarationRefusal(pkg, name)});
  if (declared.settings == null) return none;
  const refused = (why) => Object.assign({}, none, {refused: new CountinghouseError('LOAD_MODULE_FAIL', name, `its settings: ${why}`)});
  const source = storedFor(name);
  if (source.problem != null) return refused(source.problem);
  const e = effective(declared.settings, source.stored, {net});
  if (e.refused != null) return refused(e.refused);
  for (const w of e.warnings) log(`module settings: ${name}: ${w}`);
  for (const n of e.notApplied) log(`module settings: ${name}: setting ${n.setting} not applied: ${n.reason}`);
  if (operator === true && source.from === 'settingsFile' && e.notApplied.length > 0) {
    const history = path.join(path.dirname(options.settingsFile), 'history.jsonl');
    const version = isObject(pkg) && typeof(pkg.version) === 'string' ? pkg.version : 'this version';
    try {
      for (const n of e.notApplied) {
        fs.appendFileSync(history, `${JSON.stringify(Object.assign({at: new Date().toISOString(), by: 'runtime', setting: `module.${name}.${n.setting}`,
          change: `no longer valid for ${version}`}, keptOf(source.stored[n.setting])))}\n`);
      }
    } catch (err) { log(`module settings: ${name}: the history line could not be written (${err.code || err.message})`); }
  }
  if (source.from === 'moduleSettings') {
    const unset = unsetRequired(declared.settings, e.values);
    if (unset.length > 0) return refused(`required setting${unset.length > 1 ? 's' : ''} ${unset.join(', ')} unset in --moduleSettings`);
  }
  versions += 1;
  return {settings: declared.settings, values: e.values, version: versions, refused: null};
}

const confirmRule = (decl) => (decl.confirm === true || decl.type === 'string') ? 'confirm' : 'on request';

module.exports = {parseDeclaration, declarationRefusal, stateFor, readModuleSettings, checkValue, effective, unsetRequired, confirmRule, FORMATS,
  MAX_SETTINGS, MAX_DECLARATION_BYTES, MAX_VALUES_BYTES};
