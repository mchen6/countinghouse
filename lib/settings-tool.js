'use strict';
// countinghouse_settings (packs in place, part 2, plan Task A5; spec #168,
// section 3): the settings an agent without a shell may change, within
// bounds, never loosening a guarding one. The user loosens with the ch-local
// command (and, with part 3, a confirmation the agent cannot give itself).
//
// The file is ch-local's <home>/settings.json (--settingsFile), and the
// protocol is ch-local's docs/development/settings.md, which both follow:
// - {version: 1, values}, values in their stored form (requestTimeout in ms,
//   maxOutputBytes in bytes, on/off as booleans); a name this runtime does not
//   know is kept and ignored; a known one not allowed makes the file unusable;
// - <dir>/settings.lock, created whole (written, then linked), around the
//   read, the history line and the write; one 30 s stale by mtime is removed
//   if it is still the same file; waited for up to 5 s;
// - <dir>/history.jsonl, appended first: a change it cannot record is not
//   made.
// This tool only writes the file. ch-local start watches it and sends the
// runtime a control `set` for a value that applies now (applyControlSet).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const options = require('./cli-options');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const LOG = require('./logger');

const MiB = 1024 * 1024;
const size = (v) => {
  if (typeof(v) === 'number') return v;
  const m = /^(\d+)\s*(MiB|M|KiB|K|B)?$/i.exec(String(v).trim());
  if (m == null) return NaN;
  const unit = (m[2] || 'B').toLowerCase();
  return Number(m[1]) * (unit.startsWith('m') ? MiB : unit.startsWith('k') ? 1024 : 1);
};
const ms = (v) => {
  if (typeof(v) === 'number') return v;
  const m = /^(\d+)\s*(ms|s)?$/i.exec(String(v).trim());
  if (m == null) return NaN;
  return Number(m[1]) * ((m[2] || 'ms').toLowerCase() === 's' ? 1000 : 1);
};
const onOff = (v) => (v === true || v === 'on' ? true : v === false || v === 'off' ? false : null);

// The same allowlist as ch-local's lib/settings.js (keep the two in step).
// tighter(old, new): true when the change tightens or keeps a guarding one.
const ALLOWLIST = {
  locale: {parse: String, values: ['en', 'zh'], default: 'en', guarding: false, applies: 'now'},
  maxOutputBytes: {parse: size, min: MiB, max: 256 * MiB, default: 8 * MiB, guarding: true, applies: 'now', tighter: (o, n) => n <= o},
  requestTimeout: {parse: ms, min: 5000, max: 120000, default: 30000, guarding: true, applies: 'now', tighter: (o, n) => n <= o},
  // On Windows only audit, until enforce holds there (#195, lib/sandbox-platform.js).
  moduleSandbox: process.platform === 'win32'
    ? {parse: String, values: ['audit'], default: 'audit', guarding: true, applies: 'next start', tighter: (o, n) => o === n}
    : {parse: String, values: ['enforce', 'audit'], default: 'enforce', guarding: true, applies: 'next start', tighter: (o, n) => n === 'enforce' || o === n},
  autoUpgrade: {parse: onOff, values: [true, false], default: false, guarding: true, applies: 'next start', tighter: (o, n) => n === false || o === n},
  upgradeCheck: {parse: String, values: ['daily', 'weekly', 'never'], default: 'daily', guarding: false, applies: 'next start'}
};
const PACK = /^pack\.([a-z0-9][a-z0-9-]{0,63})$/;
const PACK_ENTRY = {parse: onOff, values: [true, false], default: true, guarding: true, applies: 'now', tighter: (o, n) => n === false || o === n};
const entryOf = (name) => (typeof(name) !== 'string' ? null
  : Object.prototype.hasOwnProperty.call(ALLOWLIST, name) ? ALLOWLIST[name] : PACK.test(name) ? PACK_ENTRY : null);
const shown = (v) => (v === true ? 'on' : v === false ? 'off' : v);
const boundsOf = (e) => (e.values != null ? {enum: e.values.map(shown)} : {min: e.min, max: e.max});
const boundsText = (e) => (e.values != null ? e.values.map(shown).join(', ') : `${e.min} to ${e.max}`);
const validStored = (e, v) => (e.values != null ? e.values.includes(v) : Number.isInteger(v) && v >= e.min && v <= e.max);

// Part 3 (docs/superpowers/specs/2026-11-14-guarding-settings-by-conversation-design.md,
// section 1): which loosenings conversation may ask for at all. A raised cap
// or timeout, or a pack turned on, may be asked for: it needs the user's own
// confirmation (SETTING_NEEDS_CONFIRMATION names the terminal command; a
// confirmation through the client comes with part 3's elicitation, for
// tested clients only). The sandbox and automatic upgrades are loosened from
// a terminal only (SETTING_LOOSENS_A_GUARD); off is never a value here.
const conversationMayAsk = (name) => name === 'maxOutputBytes' || name === 'requestTimeout' || PACK.test(name);

// A value as the ch-local command takes it: 64MiB, 45s, on.
function cliValue(name, v) {
  if (name === 'maxOutputBytes') return (v % MiB === 0) ? `${v / MiB}MiB` : `${v}B`;
  if (name === 'requestTimeout') return (v % 1000 === 0) ? `${v / 1000}s` : `${v}ms`;
  return String(shown(v));
}
const commandFor = (name, v) => `ch-local settings set ${name} ${cliValue(name, v)}`;

// Loosenings asked for and not made, per history file, for this start (the
// gateway makes a tool per call, so this is not the tool's own): those that
// need the user's confirmation, and those refused as terminal only (the
// sandbox, automatic upgrades: the strongest sign of an injected prompt).
// Spec sections 2 and 5: each kind (a cap, the timeout, any pack, the
// sandbox, automatic upgrades) is recorded once, whatever value or pack is
// asked for; asked again it only counts, and the count is written, under
// the lock, before the next change recorded or when the runtime ends. So a
// start writes at most five such lines and their counts, and repeated
// requests never push older history out.
const UNCONFIRMED = new Map();   // historyFile -> Map(kind -> {setting, by, count, written})
// one kind per setting, every pack.<name> one (as decline locks are kept)
const {kindOf} = require('./settings-confirm');
function pendingFor(historyFile) {
  if (!UNCONFIRMED.has(historyFile)) UNCONFIRMED.set(historyFile, new Map());
  return UNCONFIRMED.get(historyFile);
}
// The counts not yet written, as history lines (called with the lock held, or at exit).
function writeCounts(historyFile) {
  const pending = UNCONFIRMED.get(historyFile);
  if (pending == null) return;
  for (const p of pending.values()) {
    if (p.count <= p.written) continue;
    const line = {at: new Date().toISOString(), by: p.by, setting: p.setting, change: `${p.change}, asked again`, count: p.count - p.written};
    try { fs.appendFileSync(historyFile, `${JSON.stringify(line)}\n`); p.written = p.count; } catch (err) { /* said at the next */ }
  }
}
process.once('exit', () => { for (const f of UNCONFIRMED.keys()) writeCounts(f); });

// The operator's ceiling (part 3, section 4): a loosening it forbids, or a
// value above it, is SETTING_ABOVE_CEILING; a ceiling file that cannot be
// trusted refuses every loosening (SETTING_CEILING_UNTRUSTED). Tightening is
// never refused by it.
// A pack is the ceiling's allowlist's (c.packs, when present), never forbid's.
const CEILING_KIND = (name) => (PACK.test(name) ? null : name);
// Read once per process, and again when the file changes (on Windows at most
// every 5 minutes otherwise: an ACL change does not touch the file's times);
// never per call, which on Windows spawns PowerShell.
let ceilingCache = null;   // {key, at, value}
function cachedCeiling(read) {
  let key = 'none';
  const stamp = (st) => `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}:${st.uid}`;
  try {
    const file = require('./settings-ceiling').ceilingFile();
    const parts = [];
    try { parts.push(stamp(fs.lstatSync(file))); } catch (err) { if (err == null || err.code !== 'ENOENT') throw err; parts.push('none'); }
    // on POSIX each directory above it too, so a later chmod or chown of a
    // parent is seen (the review of #199)
    if (process.platform !== 'win32') {
      let d;
      try { d = fs.realpathSync.native(path.dirname(file)); } catch (err) { d = null; }
      for (; d != null; d = path.dirname(d) === d ? null : path.dirname(d)) {
        try { parts.push(`${d}=${stamp(fs.lstatSync(d))}`); } catch (err) { parts.push(`${d}=${err && err.code}`); }
      }
    }
    key = parts.join('|');
  } catch (err) { key = `error:${err && err.code}`; }
  const stale = ceilingCache == null || ceilingCache.key !== key || (process.platform === 'win32' && Date.now() - ceilingCache.at > 5 * 60 * 1000);
  if (stale) ceilingCache = {key: key, at: Date.now(), value: read()};
  return ceilingCache.value;
}
// -> null, or {code, fields} refusing the loosening of name to next.
function ceilingRefusal(ceiling, name, next) {
  if (ceiling == null || ceiling.state === 'none') return null;
  if (ceiling.state !== 'trusted') return {code: 'SETTING_CEILING_UNTRUSTED', fields: {file: ceiling.file, problem: ceiling.problem}};
  const c = ceiling.ceiling;
  const pack = PACK.exec(name);
  if (pack != null && Array.isArray(c.packs) && !c.packs.includes(pack[1])) return {code: 'SETTING_FORBIDDEN_BY_CEILING', fields: {name: name, value: cliValue(name, next)}};
  if (c.forbid.includes(CEILING_KIND(name))) return {code: 'SETTING_FORBIDDEN_BY_CEILING', fields: {name: name, value: cliValue(name, next)}};
  const max = c[name];
  if (Number.isInteger(max) && Number.isInteger(next) && next > max) return {code: 'SETTING_ABOVE_CEILING', fields: {name: name, value: cliValue(name, next), ceiling: `at most ${cliValue(name, max)}`}};
  return null;
}

// Part 3 P2 (docs/superpowers/plans/2026-11-14-part3-p2-elicitation.md,
// Task 3): a loosening conversation may ask for is confirmed by the user in
// their client's own dialog, an MCP elicitation (an InputRequiredResult),
// for a tested client only (lib/elicitation-clients.js) whose own
// configuration cannot answer it (mayElicit), and applies for this start
// only: never written to settings.json, recorded in the history first.
// The form: one boolean, no default; its text built here from the staged
// change alone (no agent-supplied text ever appears in it).
const FORM_TEXT = {
  en: {
    maxOutputBytes: (o, n) => `Allow countinghouse tools to return up to ${n} per call (now ${o})? This applies until your client restarts countinghouse.`,
    requestTimeout: (o, n) => `Allow countinghouse tool calls to run for up to ${n} (now ${o})? This applies until your client restarts countinghouse.`,
    pack: (p, v) => `Turn on the ${p} ${v} tools in countinghouse? This applies until your client restarts countinghouse.`,
    title: 'Approve'
  },
  zh: {
    maxOutputBytes: (o, n) => `允许 countinghouse 工具每次调用最多返回 ${n}（当前为 ${o}）吗？此设置在你的客户端重新启动 countinghouse 之前一直有效。`,
    requestTimeout: (o, n) => `允许 countinghouse 工具每次调用最长运行 ${n}（当前为 ${o}）吗？此设置在你的客户端重新启动 countinghouse 之前一直有效。`,
    pack: (p, v) => `要在 countinghouse 中启用工具包 ${p}（${v}）吗？此设置在你的客户端重新启动 countinghouse 之前一直有效。`,
    title: '批准'
  }
};
// this start's confirmed packs (a cap's effective value is options' own)
const packsThisStart = new Set();
// The runtime's effective value of a setting: a cap is what this runtime
// runs with (raised this start, or the start's), not the file's.
function effectiveOf(values, name) {
  if ((name === 'maxOutputBytes' || name === 'requestTimeout') && Number.isInteger(options[name])) return options[name];
  if (PACK.test(name) && packsThisStart.has(name)) return true;
  return valueOf(values, name);
}
// A pack's version as packs.json (beside the settings file, user-writable)
// gives it: strict, or null (no form).
function packVersion(dir, name) {
  const pack = PACK.exec(name);
  if (pack == null) return null;
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'packs.json'), 'utf8')); } catch (e) { return null; }
  const p = rec != null && rec.packs != null && typeof(rec.packs) === 'object' ? rec.packs[pack[1]] : null;
  const v = p != null && p.packages != null ? p.packages[`@countinghouse/ch-pack-${pack[1]}`] : null;
  return typeof(v) === 'string' && require('./elicitation-clients').isPlainVersion(v) ? v : null;
}
function formFor(name, old, next, version) {
  const text = FORM_TEXT[options.locale === 'zh-CN' ? 'zh' : 'en'];
  const pack = PACK.exec(name);
  const message = pack != null ? text.pack(pack[1], version) : text[name](cliValue(name, old), cliValue(name, next));
  return {method: 'elicitation/create', params: {mode: 'form', message: message,
    requestedSchema: {type: 'object', properties: {approve: {type: 'boolean', title: text.title}}, required: ['approve']}}};
}
// Until the client's conditions are asked of ch-local (Task 4): a tested
// client only, and then no form (its conditions are unknown).
async function defaultMayElicit(ctx) {
  const c = require('./elicitation-clients').clientMayElicit(ctx || {});
  return c.ok ? {ok: false, why: 'client conditions unknown'} : c;
}
// Until the apply (Task 5): nothing applies.
async function defaultApplyChange() {
  throw CountinghouseError.withFields('SETTING_NOT_APPLIED', {name: 'the setting', problem: 'not available in this runtime yet'});
}

const HISTORY_SHOWN = 50;
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 5000;

function fileInvalid(problem) {
  return CountinghouseError.withFields('SETTINGS_FILE_INVALID', {problem: problem});
}

// -> {raw, values}: raw is the whole values object as written (names this
// runtime does not know kept), values the known ones. Throws
// SETTINGS_FILE_INVALID for a file that cannot be used.
function readFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return {raw: {}, values: {}};
    throw fileInvalid(`it cannot be read (${err.code})`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { throw fileInvalid('it is not JSON'); }
  let raw;
  if (parsed != null && typeof(parsed) === 'object' && parsed.version === 1 && parsed.values != null && typeof(parsed.values) === 'object' && !Array.isArray(parsed.values)) raw = parsed.values;
  else if (parsed != null && typeof(parsed) === 'object' && !Array.isArray(parsed) && parsed.version == null && Object.keys(parsed).every((k) => k === 'autoUpgrade')) {
    // an earlier ch-local's {autoUpgrade}: kept only when it is a boolean,
    // never dropped on the next write
    if (parsed.autoUpgrade !== undefined && typeof(parsed.autoUpgrade) !== 'boolean') throw fileInvalid(`autoUpgrade = ${JSON.stringify(parsed.autoUpgrade).slice(0, 40)}, which is not allowed`);
    raw = (parsed.autoUpgrade !== undefined) ? {autoUpgrade: parsed.autoUpgrade} : {};
  }
  else throw fileInvalid('it is not a version 1 settings file');
  const values = {};
  for (const [name, v] of Object.entries(raw)) {
    const e = entryOf(name);
    if (e == null) continue;
    if (!validStored(e, v)) throw fileInvalid(`${name} = ${JSON.stringify(v).slice(0, 40)}, which is not allowed`);
    values[name] = v;
  }
  return {raw: raw, values: values};
}
const valueOf = (values, name) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : entryOf(name).default);

// The last HISTORY_SHOWN entries of history.jsonl, oldest first, read from
// its end in a bounded buffer (it only grows), each with only the fields the
// model is shown: never ch-local's host or pid.
const HISTORY_TAIL_BYTES = 64 * 1024;
// asked: a loosening asked for and not confirmed (never old/new, which say a change made)
const HISTORY_FIELDS = ['at', 'by', 'setting', 'old', 'new', 'change', 'loosened', 'problem', 'notice', 'asked', 'count', 'confirmed'];
function readHistory(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (err) { return []; }
  let text = '';
  let fromStart = true;
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, HISTORY_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    text = buf.toString('utf8');
    fromStart = length === size;
  } catch (err) {
    return [];
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  if (!fromStart) lines.shift();   // a line cut by the buffer's start
  const out = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry;
    try { entry = JSON.parse(line); } catch (err) { continue; }   // a torn line
    if (entry == null || typeof(entry) !== 'object') continue;
    out.push(Object.fromEntries(HISTORY_FIELDS.filter((k) => entry[k] !== undefined).map((k) => [k, entry[k]])));
  }
  return out.slice(-HISTORY_SHOWN);
}

// The lock created whole: written to a temporary file, then linked into
// place; false while another holds it.
function createWhole(lock, mine) {
  const tmp = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(mine)  }\n`);
  try {
    fs.linkSync(tmp, lock);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(tmp, {force: true});
  }
}

// Asynchronous: the main thread waits on a timer, never blocks.
async function withLock(dir, waitMs, fn) {
  const lock = path.join(dir, 'settings.lock');
  const mine = {pid: process.pid, host: os.hostname(), at: new Date().toISOString()};
  const until = Date.now() + waitMs;
  const created = () => {
    try { return createWhole(lock, mine); } catch (err) { throw fileInvalid(`its lock cannot be created (${err.code || 'error'})`); }
  };
  // every pass that does not take the lock checks the deadline and waits on
  // a timer: the main thread never spins, however often another holder
  // takes and releases it
  while (!created()) {
    let st = null;
    try { st = fs.statSync(lock); } catch (err) { st = null; }
    if (st != null && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      try { if (fs.statSync(lock).ino === st.ino) fs.rmSync(lock, {force: true}); } catch (err) { /* gone */ }
    }
    if (Date.now() > until) throw new CountinghouseError('SETTINGS_BUSY');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    return await fn();
  } finally {
    let held = null;
    try { held = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (err) { held = null; }
    if (held != null && held.pid === mine.pid && held.at === mine.at) fs.rmSync(lock, {force: true});
  }
}


// file: --settingsFile; ceiling: () -> the ceiling as lib/settings-ceiling.js
// reads it (a test gives its own). -> {get, set}
function create({file, lockWaitMs = LOCK_WAIT_MS, ceiling = () => cachedCeiling(() => require('./settings-ceiling').readCeiling()),
  mayElicit = defaultMayElicit, applyChange = defaultApplyChange}) {
  const dir = path.dirname(file);
  const historyFile = path.join(dir, 'history.jsonl');

  async function get() {
    const {values} = readFile(file);
    const c = ceiling();
    const names = [...Object.keys(ALLOWLIST), ...Object.keys(values).filter((n) => PACK.test(n)).sort()];
    return {
      settings: names.map((name) => {
        const e = entryOf(name);
        // the operator's ceiling lowers a bound (a ceiling that cannot be
        // trusted is said by set, which refuses every loosening)
        const bounds = boundsOf(e);
        if (c != null && c.state === 'trusted' && Number.isInteger(c.ceiling[name]) && bounds.max != null) bounds.max = Math.max(bounds.min, Math.min(bounds.max, c.ceiling[name]));
        return {name: name, value: shown(valueOf(values, name)), default: shown(e.default), bounds: bounds, guarding: e.guarding, applies: e.applies};
      }),
      history: readHistory(historyFile)
    };
  }

  async function set(name, value, by = 'settings tool', ctx = {}) {
    const e = entryOf(name);
    if (e == null) throw CountinghouseError.withFields('SETTING_UNKNOWN', {name: String(name).slice(0, 80)});
    const shownValue = String(value).slice(0, 80);
    const next = e.parse(value);
    if (next == null || Number.isNaN(next) || !validStored(e, next)) {
      throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: shownValue, bounds: boundsText(e)});
    }
    // the ceiling is read before the lock is taken (on Windows it may spawn PowerShell)
    const theCeiling = e.guarding ? ceiling() : null;
    const decided = await withLock(dir, lockWaitMs, async () => {
      const {raw, values} = readFile(file);
      const old = valueOf(values, name);
      const effective = effectiveOf(values, name);
      // a value equal to the current one changes nothing and records nothing,
      // so a repeated no-op cannot push real entries out of get's view
      if (next === effective) return {done: {name: name, old: shown(old), new: shown(next), applies: effective === old ? e.applies : 'this start'}};
      // this start's value differs from the file's (raised, or a pack turned
      // on, this start): a value tighter than this start's, no looser than
      // the file's, applies for this start only, written nowhere (back to
      // the file's value undoes this start's)
      if (effective !== old && (!e.guarding || e.tighter(effective, next)) && (next === old || !e.tighter(old, next))) {
        return {thisStart: {old: effective}};
      }
      // a loosening against the file or against what this runtime runs with
      // (a value tighter than a raised one but looser than the file's would
      // otherwise be written, a lasting loosening nobody confirmed)
      if (e.guarding && !(e.tighter(old, next) && e.tighter(effective, next))) {
        // part 3: the sandbox and automatic upgrades only from a terminal;
        // the others need the user's own confirmation. Either way recorded
        // (a request the history cannot record is not answered either),
        // unchanged, the command the user can run said, and said on stderr
        // once, as recorded.
        // the operator's ceiling first: what it forbids no path may do
        const above = ceilingRefusal(theCeiling, name, next);
        const terminalOnly = !conversationMayAsk(name);
        const confirms = require('./settings-confirm').confirmations();
        // no form: refused by the ceiling, terminal only, conversation off by
        // the ceiling, declined this start, or no forms left
        const noForm = above != null ? 'refused by the ceiling' : terminalOnly ? 'refused, terminal only'
          : (theCeiling != null && theCeiling.state === 'trusted' && theCeiling.ceiling.conversation === false) ? 'not confirmed (conversation off by the ceiling)'
            : confirms.declined(name) ? 'not confirmed (declined this start)'
              : confirms.formsLeft() <= 0 ? 'not confirmed (no forms left this start)' : null;
        if (noForm != null) {
          refuseAsked(name, next, by, noForm);
          if (above != null) throw CountinghouseError.withFields(above.code, above.fields);
          if (confirms.declined(name) && !terminalOnly) throw CountinghouseError.withFields('SETTING_DECLINED_THIS_START', {name: name, command: commandFor(name, next)});
          throw CountinghouseError.withFields(terminalOnly ? 'SETTING_LOOSENS_A_GUARD' : 'SETTING_NEEDS_CONFIRMATION',
            {name: name, value: cliValue(name, next), command: commandFor(name, next)});
        }
        // a form may be sent: decided outside the lock (the conditions are
        // asked of ch-local, whose applier takes this lock too)
        return {ask: {old: effective}};
      }
      // The new file is written aside first; then the change is recorded (a
      // change the history cannot hold is not made); then the file is
      // renamed into place. A rename that fails after the history line is
      // said in the history too, so it never shows a change not made.
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify({version: 1, values: Object.assign({}, raw, {[name]: next})}, null, 2)}\n`);
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        throw fileInvalid(`it cannot be written (${err.code || 'error'})`);
      }
      // the counts of requests not confirmed go before this change, in order
      writeCounts(historyFile);
      const line = {at: new Date().toISOString(), by: by, setting: name, old: old, new: next};
      try {
        fs.appendFileSync(historyFile, `${JSON.stringify(line)}\n`);
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        throw new CountinghouseError('SETTING_NOT_RECORDED');
      }
      try {
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        try { fs.appendFileSync(historyFile, `${JSON.stringify({at: new Date().toISOString(), by: by, setting: name, change: 'not made', problem: err.code || 'error'})}\n`); } catch (e) { /* the error below says it */ }
        throw fileInvalid(`it cannot be replaced (${err.code || 'error'})`);
      }
      // said on stderr too (spec #168 section 3), as the history has it
      // (the logger exists once the runtime serves; a change is never undone
      // by a line that could not be logged)
      try { LOG.I(`countinghouse_settings: ${name} changed from ${JSON.stringify(shown(old))} to ${JSON.stringify(shown(next))} by ${by}`); } catch (err) { /* not serving */ }
      // a tightened cap applies on the main thread at once (it checks every
      // result), so this runtime's effective value is never staler than the
      // file it just wrote; ch-local's control set repeats it for the workers
      if ((name === 'maxOutputBytes' || name === 'requestTimeout') && Number.isInteger(options[name]) && next < options[name]) options[name] = next;
      return {done: {name: name, old: shown(old), new: shown(next), applies: e.applies}};
    });
    if (decided.done != null) return decided.done;
    if (decided.thisStart != null) return applyThisStart(name, decided.thisStart.old, next, by);
    return formOrRefusal(name, next, decided.ask.old, by, ctx);
  }

  // A tightening of this start's value (no form): recorded, then applied.
  async function applyThisStart(name, old, next, by) {
    await withLock(dir, lockWaitMs, async () => {
      writeCounts(historyFile);
      appendLine({by: by, setting: name, old: old, new: next, change: 'this start'}, true);
    });
    await applyChange({name: name, old: old, next: next, version: null, client: null});
    if (PACK.test(name)) { if (next === true) packsThisStart.add(name); else packsThisStart.delete(name); }
    return {name: name, old: shown(old), new: shown(next), applies: 'this start'};
  }

  // The same form again, for a retry that carries no answer.
  function sameForm(check) {
    const st = check.staged;
    return {inputRequired: {inputRequests: {approve: formFor(st.name, st.old, st.next, st.version)}, requestState: check.requestState}};
  }

  // The conditions, then the form, or the terminal command.
  async function formOrRefusal(name, next, old, by, ctx) {
    const may = await mayElicit(ctx);
    const version = PACK.test(name) ? packVersion(dir, name) : null;
    const why = may == null || may.ok !== true ? String((may && may.why) || 'client conditions unknown')
      : (PACK.test(name) && version == null) ? 'the pack\'s version is not a plain one' : null;
    if (why != null) {
      refuseAsked(name, next, by, `not confirmed (${why})`);
      throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    }
    const confirms = require('./settings-confirm').confirmations();
    const client = may.client != null && typeof(may.client.name) === 'string' && typeof(may.client.version) === 'string' ? may.client : null;
    const staged = client == null ? null : confirms.stage({name: name, old: old, next: next, version: version, client: client, session: ctx.session});
    if (staged == null) {
      refuseAsked(name, next, by, client == null ? 'not confirmed (client unknown)' : 'not confirmed (no forms left this start)');
      throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    }
    const {requestState, replaced} = staged;
    if (replaced != null) appendLine({by: by, setting: replaced.name, asked: replaced.next, change: 'replaced'});
    return {inputRequired: {inputRequests: {approve: formFor(name, old, next, version)}, requestState: requestState}};
  }

  // The retry with the user's answer. -> {name, old, new, applies: 'this
  // start' | 'declined'}, a fresh {inputRequired} when there is no answer, or
  // throws.
  async function confirm(name, value, {requestState, inputResponses} = {}, ctx = {}) {
    const e = entryOf(name);
    if (e == null) throw CountinghouseError.withFields('SETTING_UNKNOWN', {name: String(name).slice(0, 80)});
    const next = e.parse(value);
    if (next == null || Number.isNaN(next) || !validStored(e, next)) {
      throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: String(value).slice(0, 80), bounds: boundsText(e)});
    }
    const by = 'settings tool';
    const answer = inputResponses != null && typeof(inputResponses) === 'object' ? inputResponses.approve : undefined;
    const confirms = require('./settings-confirm').confirmations();
    // no answer: the same form again (the protocol asks the server not to
    // fail it), spending no other and using nothing up
    if (answer == null || typeof(answer) !== 'object') {
      const check = confirms.check(requestState, {name: name, next: next, session: ctx.session});
      if (!check.ok) throw new CountinghouseError(check.code);
      return sameForm(check);
    }
    const v = confirms.verify(requestState, {name: name, next: next, session: ctx.session});
    if (!v.ok) {
      if (v.code === 'SETTING_CONFIRMATION_EXPIRED') appendLine({by: by, setting: name, asked: next, change: 'expired'});
      throw new CountinghouseError(v.code);
    }
    const staged = v.staged;
    // only an explicit true accepts: a decline, a cancel, or anything else is no
    const accepted = answer.action === 'accept' && answer.content != null && typeof(answer.content) === 'object' && answer.content.approve === true;
    if (!accepted) {
      confirms.decline(name);
      appendLine({by: by, setting: name, asked: next, change: 'declined'});
      return {name: name, old: shown(staged.old), new: shown(staged.old), applies: 'declined'};
    }
    // the client's conditions again, now (a hook written while the dialog was up)
    const may = await mayElicit(ctx);
    if (may == null || may.ok !== true) {
      refuseAsked(name, next, by, `not confirmed (${String((may && may.why) || 'client conditions unknown')})`);
      throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    }
    // checked again and recorded under the lock, then applied outside it:
    // the ceiling (and its conversation switch), and the decline lock
    const theCeiling = ceiling();
    if ((theCeiling != null && theCeiling.state === 'trusted' && theCeiling.ceiling.conversation === false) || confirms.declined(name)) {
      refuseAsked(name, next, by, confirms.declined(name) ? 'not confirmed (declined this start)' : 'not confirmed (conversation off by the ceiling)');
      throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    }
    await withLock(dir, lockWaitMs, async () => {
      const {values} = readFile(file);
      if (effectiveOf(values, name) !== staged.old) throw CountinghouseError.withFields('SETTING_CHANGED_MEANWHILE', {name: name});
      const above = ceilingRefusal(theCeiling, name, next);
      if (above != null) throw CountinghouseError.withFields(above.code, above.fields);
      writeCounts(historyFile);
      appendLine({by: by, setting: name, old: staged.old, new: next, change: 'this start',
        confirmed: `elicitation (${staged.client.name} ${staged.client.version})`}, true);
    });
    try {
      await applyChange(staged);
    } catch (err) {
      appendLine({by: by, setting: name, change: 'not applied', problem: String((err && (err.code || err.message)) || 'error').slice(0, 80)});
      throw (err instanceof CountinghouseError) ? err : CountinghouseError.withFields('SETTING_NOT_APPLIED', {name: name, problem: String((err && (err.code || err.message)) || 'error').slice(0, 80)});
    }
    if (PACK.test(name)) { if (next === true) packsThisStart.add(name); else packsThisStart.delete(name); }
    try { LOG.I(`countinghouse_settings: ${name} changed from ${JSON.stringify(shown(staged.old))} to ${JSON.stringify(shown(next))} for this start, confirmed in ${staged.client.name}`); } catch (err) { /* not serving */ }
    return {name: name, old: shown(staged.old), new: shown(next), applies: 'this start'};
  }

  // One history line; strict: a line that cannot be written refuses (a
  // change the history cannot hold is not made).
  function appendLine(line, strict = false) {
    try {
      fs.appendFileSync(historyFile, `${JSON.stringify(Object.assign({at: new Date().toISOString()}, line))}\n`);
    } catch (err) {
      if (strict) throw new CountinghouseError('SETTING_NOT_RECORDED');
    }
  }

  // A request not made: recorded once per kind and outcome, and said.
  function refuseAsked(name, next, by, change) {
    // a reason (some from outside: ch-local's) one plain line, cut
    change = String(change).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').slice(0, 120);
    let written;
    try { written = recordAsked(name, next, by, change); } catch (err) { throw new CountinghouseError('SETTING_NOT_RECORDED'); }
    if (written) { try { LOG.I(`countinghouse_settings: ${name} to ${JSON.stringify(shown(next))} asked for by ${by}, ${change}`); } catch (err) { /* not serving */ } }
  }

  // change: 'not confirmed' or 'refused, terminal only'. -> true when a
  // history line was written (the first of its kind this start).
  function recordAsked(name, next, by, change) {
    const pending = pendingFor(historyFile);
    // grouped per kind and outcome (the reason aside, the first one kept),
    // so a count is never filed under another's and varying reasons add none
    const kind = `${kindOf(name)}\0${String(change).replace(/ \(.*$/, '')}`;
    const p = pending.get(kind);
    if (p != null) { p.count += 1; return false; }
    fs.appendFileSync(historyFile, `${JSON.stringify({at: new Date().toISOString(), by: by, setting: name, asked: next, change: change})}\n`);
    pending.set(kind, {setting: kindOf(name) === 'pack' ? 'pack' : name, by: by, change: change, count: 1, written: 1});
    return true;
  }

  return {get: get, set: set, confirm: confirm, writeCounts: () => writeCounts(historyFile)};
}

// ch-local start's control `set {name, value}`, the value in the runtime's
// unit, as its option takes it (--requestTimeout in seconds, --locale en-US
// or zh-CN). It takes effect for the next call: a running call keeps the
// timer it started with.
//
// Module and validator workers hold the options they were started with (the
// validators' heap is sized from maxOutputBytes), and the main thread checks
// every call's output size and deadline. So a value at or under the one this
// runtime started with applies now, on the main thread, for every call; a
// higher one, which the workers would not hold, applies at the next start
// (CONTROL_APPLIES_AT_START; ch-local says so). countinghouse_settings only
// tightens, so its changes always apply now. A worker's own error texts keep
// the locale it started with.
const LOCALES = ['en-US', 'zh-CN'];
let atStart = null;
// A backstop for ch-local's control set (ch-local clamps to the ceiling
// itself, part 3 P4): a value above a trusted ceiling, or any raise above
// the start value under one that cannot be trusted, is refused here too.
let controlCeiling = () => cachedCeiling(() => require('./settings-ceiling').readCeiling());
function aboveControlCeiling(name, value) {
  const c = controlCeiling();
  if (c == null || c.state === 'none') return false;
  if (c.state !== 'trusted') return value > options[name];
  return Number.isInteger(c.ceiling[name]) && value > c.ceiling[name];
}
function applyControlSet(msg) {
  const name = msg != null ? msg.name : null;
  const value = msg != null ? msg.value : null;
  if (atStart == null) atStart = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
  switch (name) {
    case 'locale':
      if (!LOCALES.includes(value)) return {ok: false, code: 'SETTING_OUT_OF_BOUNDS'};
      options.locale = value;
      return {ok: true};
    case 'maxOutputBytes':
      if (!validStored(ALLOWLIST.maxOutputBytes, value)) return {ok: false, code: 'SETTING_OUT_OF_BOUNDS'};
      if (aboveControlCeiling('maxOutputBytes', value)) return {ok: false, code: 'SETTING_ABOVE_CEILING'};
      if (value > atStart.maxOutputBytes) return {ok: false, code: 'CONTROL_APPLIES_AT_START'};
      options.maxOutputBytes = value;
      return {ok: true};
    case 'requestTimeout': {
      const msValue = Number.isInteger(value) ? value * 1000 : NaN;
      if (!validStored(ALLOWLIST.requestTimeout, msValue)) return {ok: false, code: 'SETTING_OUT_OF_BOUNDS'};
      if (aboveControlCeiling('requestTimeout', msValue)) return {ok: false, code: 'SETTING_ABOVE_CEILING'};
      if (msValue > atStart.requestTimeout) return {ok: false, code: 'CONTROL_APPLIES_AT_START'};
      options.requestTimeout = msValue;
      return {ok: true};
    }
    default:
      // a pack is turned off by unloading it (control unload), and the
      // others apply at the next start; the CONTROL_* codes stay internal
      return {ok: false, code: entryOf(name) != null ? 'CONTROL_NOT_LIVE' : 'CONTROL_UNKNOWN_SETTING'};
  }
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {type: 'string', enum: ['get', 'set']},
    name: {type: 'string', description: 'set: the setting, as get lists it (pack.<name> turns a pack off)'},
    value: {type: ['string', 'number', 'boolean'], description: 'set: the new value, within its bounds (sizes like 4MiB, times like 20s, on/off)'}
  },
  required: ['action'],
  additionalProperties: false
};

// The options a control set changes, as a module worker holds them: sent to
// every running module worker after a set (broadcastLiveOptions), so a
// worker started after a tighten, holding the tighter value, takes a
// loosening back up too. A worker started later reads the current values
// (getOptionsForWorker).
const LIVE_FIELDS = ['maxOutputBytes', 'requestTimeout', 'locale'];
function liveOptions() {
  return Object.fromEntries(LIVE_FIELDS.map((k) => [k, options[k]]));
}
// main thread: modules is ModuleManager's {name: WorkerMessage}
function broadcastLiveOptions(modules) {
  const message = {command: 'live-options', options: liveOptions()};
  for (const wm of Object.values(modules || {})) {
    if (wm == null || typeof(wm.sendMessageToWorker) !== 'function') continue;
    try { wm.sendMessageToWorker(Object.assign({}, message)); } catch (err) { /* a worker ending: it is not called again */ }
  }
}
// worker (lib/sandbox.js): only those fields, each of its own type
function applyLiveOptions(target, sent) {
  if (sent == null || typeof(sent) !== 'object') return;
  for (const k of LIVE_FIELDS) {
    const v = sent[k];
    if (k === 'locale' ? LOCALES.includes(v) : (Number.isInteger(v) && v > 0)) target[k] = v;
  }
}

// For tests: forget the values recorded at the first control set and the
// cached ceiling; ceilingForControl(fn) replaces the control set's ceiling.
function resetForTests() { atStart = null; ceilingCache = null; packsThisStart.clear(); }
function ceilingForControl(fn) { controlCeiling = fn; }

module.exports = {create, applyControlSet, liveOptions, broadcastLiveOptions, applyLiveOptions, resetForTests, ceilingForControl, ALLOWLIST, INPUT_SCHEMA};
