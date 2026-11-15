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
  maxOutputBytes: {parse: size, min: MiB, max: 256 * MiB, default: 16 * MiB, guarding: true, applies: 'now', tighter: (o, n) => n <= o},
  requestTimeout: {parse: ms, min: 5000, max: 120000, default: 30000, guarding: true, applies: 'now', tighter: (o, n) => n <= o},
  moduleSandbox: {parse: String, values: ['enforce', 'audit'], default: 'enforce', guarding: true, applies: 'next start', tighter: (o, n) => n === 'enforce' || o === n},
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
// trusted refuses every loosening (SETTING_CEILING_UNTRUSTED). A tightening
// of what the runtime runs with is never refused by it; a write that only
// tightens a stored value, and is above both the ceiling and what runs, is
// (set: it would put a value above the ceiling in the file).
// A pack is the ceiling's allowlist's (c.packs, when present), never forbid's.
const CEILING_KIND = (name) => (PACK.test(name) ? null : name);
// Read once per process, and again when the file changes (on Windows at most
// every 5 minutes otherwise: an ACL change does not touch the file's times);
// never per call, which on Windows spawns PowerShell.
let ceilingCache = null;   // {key, at, value}
// {cacheOnly}: never read (spawning nothing): the cached value while its key
// is the file's (the Windows age rule aside: a value read just before the
// lock is current), else undefined (inside settings.lock, where nothing slow
// runs). platform and now: a test's.
function cachedCeiling(read, {cacheOnly = false, platform = process.platform, now = Date.now} = {}) {
  let key = 'none';
  const stamp = (st) => `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}:${st.uid}`;
  try {
    const file = require('./settings-ceiling').ceilingFile();
    const parts = [];
    try { parts.push(stamp(fs.lstatSync(file))); } catch (err) { if (err == null || err.code !== 'ENOENT') throw err; parts.push('none'); }
    // on POSIX each directory above it too, so a later chmod or chown of a
    // parent is seen (the review of #199)
    if (platform !== 'win32') {
      let d;
      try { d = fs.realpathSync.native(path.dirname(file)); } catch (err) { d = null; }
      for (; d != null; d = path.dirname(d) === d ? null : path.dirname(d)) {
        try { parts.push(`${d}=${stamp(fs.lstatSync(d))}`); } catch (err) { parts.push(`${d}=${err && err.code}`); }
      }
    }
    key = parts.join('|');
  } catch (err) { key = `error:${err && err.code}`; }
  if (cacheOnly) return ceilingCache != null && ceilingCache.key === key ? ceilingCache.value : undefined;
  const stale = ceilingCache == null || ceilingCache.key !== key || (platform === 'win32' && now() - ceilingCache.at > 5 * 60 * 1000);
  if (stale) {
    ceilingCache = {key: key, at: now(), value: read()};
    // a re-read ceiling: every session's stored loosenings are clamped to it
    // (lib/session-settings.js ceilingSeen; idle sessions too)
    try { require('./session-settings').ceilingSeen(ceilingCache.value); } catch (e) { /* not this runtime's concern */ }
  }
  return ceilingCache.value;
}
// the two caps: what this runtime runs with is their value (effectiveOf)
const isCap = (name) => name === 'maxOutputBytes' || name === 'requestTimeout';
// whether settings.json holds a value for the setting (not its default)
const isStored = (values, name) => Object.prototype.hasOwnProperty.call(values, name);
// -> null, or {code, fields}: next is above a trusted ceiling's own number
// (whatever else the ceiling says: this is asked of every write)
function aboveCeiling(ceiling, name, next) {
  if (ceiling == null || ceiling.state !== 'trusted' || ceiling.ceiling == null) return null;
  const max = ceiling.ceiling[name];
  if (!Number.isInteger(max) || !Number.isInteger(next) || next <= max) return null;
  return {code: 'SETTING_ABOVE_CEILING', fields: {name: name, value: cliValue(name, next), ceiling: `at most ${cliValue(name, max)}`}};
}
// -> null, or {code, fields} refusing the loosening of name to next.
function ceilingRefusal(ceiling, name, next) {
  if (ceiling == null || ceiling.state === 'none') return null;
  if (ceiling.state !== 'trusted') return {code: 'SETTING_CEILING_UNTRUSTED', fields: {file: ceiling.file, problem: ceiling.problem}};
  const c = ceiling.ceiling;
  const pack = PACK.exec(name);
  if (pack != null && Array.isArray(c.packs) && !c.packs.includes(pack[1])) return {code: 'SETTING_FORBIDDEN_BY_CEILING', fields: {name: name, value: cliValue(name, next)}};
  if (c.forbid.includes(CEILING_KIND(name))) return {code: 'SETTING_FORBIDDEN_BY_CEILING', fields: {name: name, value: cliValue(name, next)}};
  return aboveCeiling(ceiling, name, next);
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
  if (isCap(name) && Number.isInteger(options[name])) return options[name];
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
// The client's own conditions (Task 4): a tested client (Task 1), then
// ch-local's answer to may-elicit, read from the client's own configuration
// (hooks, plugins, the session's entrypoint). No answer, no channel, or an
// older ch-local: no form ('client conditions unknown').
async function defaultMayElicit(ctx, allowlist) {
  const c = require('./elicitation-clients').clientMayElicit(ctx || {}, allowlist);
  if (!c.ok) return c;
  const reply = await require('./control-channel').ask({type: 'may-elicit', client: c.client});
  if (reply != null && reply.ok === true && reply.mayElicit === true) return {ok: true, client: c.client};
  if (reply != null && reply.ok === true) return {ok: false, why: String(reply.why || 'the client\'s configuration could answer for the user')};
  return {ok: false, why: 'client conditions unknown'};
}
// Until the apply (Task 5): nothing applies.
// Applying a change for this start only (part 3 P2, Task 5), confirmed in
// the client or a tightening of this start's value: staged {name, old, next,
// version}; deps {pool, modules(), ask} (production's: liveDeps). Never
// awaited inside settings.lock (the caller applies outside it).
// - maxOutputBytes: the validators resized first (a validator with the old
//   heap would crash on the bigger value); only once that resolves, and the
//   value is still the staged old one, the option is set and every module
//   worker told;
// - requestTimeout: set, and every worker told (no restart);
// - a pack: ch-local asked to load it (load-pack, the version the form
//   showed; 45 s, past ch-local's own 30 s load), or to unload one turned on
//   this start (unload-pack); a refusal applies nothing.
// A raise lifts the control set's start cap for this value only, so a later
// set from ch-local up to it applies.
const LOAD_PACK_MS = 45000;
async function applyConfirmed(staged, deps) {
  const name = String(staged.name);
  const pack = PACK.exec(name);
  const notApplied = (problem) => CountinghouseError.withFields('SETTING_NOT_APPLIED', {name: name, problem: String(problem).slice(0, 80)});
  // the values this runtime started with, before anything here changes one
  captureAtStart();
  const loosening = pack != null ? staged.next === true : staged.next > staged.old;
  // the operator's ceiling again, when this applies (a resize or a load can
  // take a while): one lowered, untrusted or turned against conversation
  // meanwhile wins. A tightening is never refused.
  const ceilingAllows = () => {
    if (!loosening || typeof(deps.ceiling) !== 'function') return;
    const c = deps.ceiling();
    if ((c != null && c.state === 'trusted' && c.ceiling.conversation === false) || ceilingRefusal(c, name, staged.next) != null) {
      throw CountinghouseError.withFields('SETTING_CEILING_CHANGED_MEANWHILE', {name: name});
    }
  };
  ceilingAllows();
  if (pack != null) {
    const msg = staged.next === true ? {type: 'load-pack', name: pack[1], version: staged.version} : {type: 'unload-pack', name: pack[1]};
    const reply = await deps.ask(msg, {timeoutMs: LOAD_PACK_MS});
    if (reply == null || reply.ok !== true) {
      // a load-pack with no answer may still land in ch-local: undone, so
      // nothing is left on that the user was told did not change
      if (staged.next === true && reply != null && reply.code === 'CONTROL_NO_ANSWER') {
        Promise.resolve(deps.ask({type: 'unload-pack', name: pack[1]}, {timeoutMs: LOAD_PACK_MS})).catch(() => {});
      }
      throw notApplied((reply && reply.code) || 'CONTROL_FAILED');
    }
    return;
  }
  if (name !== 'maxOutputBytes' && name !== 'requestTimeout') throw notApplied('not live');
  // every module worker holds its own copy of the option: with none to tell
  // (a serving path that did not hand its modules over), nothing applies
  if (typeof(deps.modules) !== 'function') throw notApplied('no running modules to tell');
  if (name === 'maxOutputBytes' && deps.pool != null && staged.next > staged.old) {
    try { await deps.pool.resize(staged.next); } catch (err) { throw notApplied((err && err.code) || 'RESIZE_FAILED'); }
  }
  // checked again after the await: another change meanwhile wins, and the
  // ceiling as it is now
  if (options[name] !== staged.old) throw CountinghouseError.withFields('SETTING_CHANGED_MEANWHILE', {name: name});
  ceilingAllows();
  options[name] = staged.next;
  if (staged.next > atStart[name]) atStart[name] = staged.next;
  broadcastLiveOptions(deps.modules());
}

// The running runtime's: the shared validator pool once started, its
// modules (set by lib/route-manager.js when it serves), and the control
// channel's ask.
let liveModules = null;
function setLiveModules(fn) { liveModules = typeof(fn) === 'function' ? fn : null; }
const liveDeps = () => ({
  pool: require('./validator-pool').started(),
  modules: liveModules,
  ceiling: () => controlCeiling(),
  ask: (msg, opts) => require('./control-channel').ask(msg, opts)
});
// ch-local unloaded a pack (its scenario's package name): one turned on this
// start is off again (a ceiling that stopped allowing it, say), so a later
// set sees it off and asks again
function packUnloaded(scenario) {
  const m = /^@countinghouse\/ch-pack-([a-z0-9][a-z0-9-]{0,63})$/.exec(String(scenario));
  if (m != null) packsThisStart.delete(`pack.${m[1]}`);
}
async function defaultApplyChange(staged) {
  return applyConfirmed(staged, liveDeps());
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
// allowlist: the tested clients (lib/elicitation-clients.js's frozen one; a
// test's own copy with a range set)
function create({file, lockWaitMs = LOCK_WAIT_MS, ceiling = (o) => cachedCeiling(() => require('./settings-ceiling').readCeiling(), o),
  allowlist = require('./elicitation-clients').ALLOWLIST, mayElicit = (ctx) => defaultMayElicit(ctx, allowlist), applyChange = defaultApplyChange}) {
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
        // a cap's value is what this runtime runs with (ch-local may have
        // started it under the ceiling, with nothing stored); the stored one
        // is said beside it when it differs (a terminal change awaiting the
        // next start, a raise confirmed for this start)
        const value = isCap(name) ? effectiveOf(values, name) : valueOf(values, name);
        const stored = (isCap(name) && isStored(values, name) && values[name] !== value) ? {stored: shown(values[name])} : {};
        return Object.assign({name: name, value: shown(value)}, stored, {default: shown(e.default), bounds: bounds, guarding: e.guarding, applies: e.applies});
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
      const effective = effectiveOf(values, name);
      // What a change is judged against: the stored value. For a cap with
      // nothing stored that is what this runtime STARTED with (startedWith),
      // not the allowlist's default: ch-local starts the runtime under the
      // operator's ceiling (or a flag was given), and a value between the
      // two is a loosening of what it runs, never a tightening of a default
      // that was never in force. Not what it runs with now: a raise
      // confirmed this start is above its start value, and is judged against
      // that (below). Before a start was recorded (no runtime serving), the
      // default.
      const begun = (isCap(name) && !isStored(values, name)) ? startedWith(name) : null;
      const old = begun != null ? begun : valueOf(values, name);
      // the file says this value already, by a stored value or by its default
      const kept = isStored(values, name) || next === e.default;
      // a value equal to the file's and to this runtime's changes nothing and
      // records nothing, so a repeated no-op cannot push real entries out of
      // get's view. (One the runtime only started with, under the default,
      // is not in the file: asked for, it is stored below, so it holds when
      // the ceiling or the flag that gave it is gone.)
      if (next === old && next === effective && kept) return {done: {name: name, old: shown(old), new: shown(next), applies: e.applies}};
      // raised this start (a confirmed raise, or a pack turned on): looser
      // than the file. The same value again is a no-op; one tighter than
      // this start's and no tighter than the file's applies for this start
      // only, written nowhere (the file's own value undoes this start's), and
      // is recorded here, in the lock that decided it. One tighter than the
      // file's is written below, as any tightening.
      if (e.guarding && effective !== old && !e.tighter(old, effective)) {
        if (next === effective) return {done: {name: name, old: shown(old), new: shown(next), applies: 'this start'}};
        if (e.tighter(effective, next) && (next === old || !e.tighter(old, next))) {
          writeCounts(historyFile);
          appendLine({by: by, setting: name, old: effective, new: next, change: 'this start'}, true);
          return {thisStart: {old: effective}};
        }
      }
      // the file's value already, this runtime still on another (a terminal
      // change awaiting the next start): nothing to write
      if (next === old && kept) return {done: {name: name, old: shown(old), new: shown(next), applies: 'next start'}};
      // a loosening is only what is looser than the file's (a tightening of
      // the file is always written, whatever this runtime runs with)
      if (e.guarding && !e.tighter(old, next)) {
        // part 3: the sandbox and automatic upgrades only from a terminal;
        // the others need the user's own confirmation. Either way recorded
        // (a request the history cannot record is not answered either),
        // unchanged, the command the user can run said, and said on stderr
        // once, as recorded.
        // the operator's ceiling first: what it forbids no path may do
        const above = ceilingRefusal(theCeiling, name, next);
        const terminalOnly = !conversationMayAsk(name);
        const confirms = require('./settings-confirm').confirmations();
        // a pending form past its time counts as an expiry before the decline
        // lock is read (the second locks the kind before a third is sent)
        const swept = confirms.sweep();
        if (swept != null) appendLine({by: by, setting: swept.name, asked: swept.next, change: 'expired'});
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
      // A write above the ceiling AND above what this runtime runs with is
      // refused, though it tightens a stored value: it would put a value the
      // operator forbids in the file for the next start. A tightening of
      // what runs is never refused, even one still above the ceiling (a
      // runtime above a ceiling lowered under it is brought down by it). A
      // ceiling that cannot be trusted, or that forbids loosening, refuses
      // no tightening.
      const over = (Number.isInteger(effective) && next <= effective) ? null : aboveCeiling(theCeiling, name, next);
      if (over != null) {
        refuseAsked(name, next, by, 'refused by the ceiling');
        throw CountinghouseError.withFields(over.code, over.fields);
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
      // a pack's value written to the file is what governs it now: this
      // start's turn-on (ch-local drops its own on the same change) is over
      if (PACK.test(name)) packsThisStart.delete(name);
      // said on stderr too (spec #168 section 3), as the history has it
      // (the logger exists once the runtime serves; a change is never undone
      // by a line that could not be logged)
      try { LOG.I(`countinghouse_settings: ${name} changed from ${JSON.stringify(shown(old))} to ${JSON.stringify(shown(next))} by ${by}`); } catch (err) { /* not serving */ }
      // a tightened cap applies on the main thread at once (it checks every
      // result), so this runtime's effective value is never staler than the
      // file it just wrote; ch-local's control set repeats it for the workers
      if (isCap(name) && Number.isInteger(options[name]) && next < options[name]) options[name] = next;
      // a cap written above what runs (a tightening of a stored value this
      // runtime does not run with yet) changes nothing now
      const applies = (isCap(name) && Number.isInteger(effective) && next > effective) ? 'next start' : e.applies;
      return {done: {name: name, old: shown(old), new: shown(next), applies: applies}};
    });
    if (decided.done != null) return decided.done;
    if (decided.thisStart != null) return applyThisStart(name, decided.thisStart.old, next, by);
    return formOrRefusal(name, next, decided.ask.old, by, ctx);
  }

  // A tightening of this start's value (no form), recorded when decided:
  // applied, or said as not applied.
  async function applyThisStart(name, old, next, by) {
    try {
      await applyChange({name: name, old: old, next: next, version: null, client: null});
    } catch (err) {
      // a code, never an error's message (which can carry anything)
      const problem = String((err && typeof(err.code) === 'string' && err.code) || 'error').slice(0, 80);
      appendLine({by: by, setting: name, change: 'not applied', problem: problem});
      throw (err instanceof CountinghouseError) ? err : CountinghouseError.withFields('SETTING_NOT_APPLIED', {name: name, problem: problem});
    }
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
    const confirms = require('./settings-confirm').confirmations();
    // checked again after the await: a form that expired meanwhile counts,
    // and a kind locked meanwhile gets no form
    const swept = confirms.sweep();
    if (swept != null) appendLine({by: by, setting: swept.name, asked: swept.next, change: 'expired'});
    if (confirms.declined(name)) {
      refuseAsked(name, next, by, 'not confirmed (declined this start)');
      throw CountinghouseError.withFields('SETTING_DECLINED_THIS_START', {name: name, command: commandFor(name, next)});
    }
    const client = may != null && may.ok === true && may.client != null && typeof(may.client.name) === 'string' && typeof(may.client.version) === 'string' ? may.client : null;
    const session = ctx != null && typeof(ctx.session) === 'string' && ctx.session.length > 0 ? ctx.session : null;
    const why = may == null || may.ok !== true ? String((may && may.why) || 'client conditions unknown')
      : client == null ? 'client unknown'
        : session == null ? 'session unknown'
          : (PACK.test(name) && version == null) ? 'the pack\'s version is not a plain one'
            : confirms.formsLeft() <= 0 ? 'no forms left this start' : null;
    const staged = why == null ? confirms.stage({name: name, old: old, next: next, version: version, client: client, session: session}) : null;
    if (staged == null) {
      refuseAsked(name, next, by, `not confirmed (${why || 'no forms left this start'})`);
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
      if (!check.ok) {
        if (check.code === 'SETTING_CONFIRMATION_EXPIRED') appendLine({by: by, setting: name, asked: next, change: 'expired'});
        throw new CountinghouseError(check.code);
      }
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
    // for the client the form was staged for (the one the history names)
    const sameClient = may != null && may.client != null && staged.client != null
      && may.client.name === staged.client.name && may.client.version === staged.client.version;
    if (may == null || may.ok !== true || !sameClient) {
      refuseAsked(name, next, by, `not confirmed (${may != null && may.ok === true ? 'another client' : String((may && may.why) || 'client conditions unknown')})`);
      throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    }
    // checked again and recorded under the lock, with no await between the
    // checks and the line, then applied outside it: the ceiling (and its
    // conversation switch), the decline lock, the current value. Every
    // refusal here leaves its line.
    // the ceiling read before the lock (on Windows a read spawns
    // PowerShell); inside it, from the cache only, and the same one
    const theCeiling = ceiling();
    await withLock(dir, lockWaitMs, async () => {
      const again = ceiling({cacheOnly: true});
      if (again === undefined || JSON.stringify(again) !== JSON.stringify(theCeiling)) {
        appendLine({by: by, setting: name, asked: next, change: 'not applied (ceiling changed meanwhile)'});
        throw CountinghouseError.withFields('SETTING_CEILING_CHANGED_MEANWHILE', {name: name});
      }
      if (confirms.declined(name)) {
        refuseAsked(name, next, by, 'not confirmed (declined this start)');
        throw CountinghouseError.withFields('SETTING_DECLINED_THIS_START', {name: name, command: commandFor(name, next)});
      }
      if (theCeiling != null && theCeiling.state === 'trusted' && theCeiling.ceiling.conversation === false) {
        refuseAsked(name, next, by, 'not confirmed (conversation off by the ceiling)');
        throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
      }
      const {values} = readFile(file);
      if (effectiveOf(values, name) !== staged.old) {
        appendLine({by: by, setting: name, asked: next, change: 'not applied (changed meanwhile)'});
        throw CountinghouseError.withFields('SETTING_CHANGED_MEANWHILE', {name: name});
      }
      const above = ceilingRefusal(theCeiling, name, next);
      if (above != null) {
        const which = above.code === 'SETTING_CEILING_UNTRUSTED' ? 'ceiling untrusted' : above.code === 'SETTING_FORBIDDEN_BY_CEILING' ? 'forbidden by the ceiling' : 'above the ceiling';
        appendLine({by: by, setting: name, asked: next, change: `not applied (${which})`});
        throw CountinghouseError.withFields(above.code, above.fields);
      }
      writeCounts(historyFile);
      appendLine({by: by, setting: name, old: staged.old, new: next, change: 'this start',
        confirmed: `elicitation (${staged.client.name} ${staged.client.version})`}, true);
    });
    // never silent (part 3, section 5): what was applied, or what was not,
    // is told to the user as a notice (the next result of any tool, and
    // notifications/message) and logged. A pack's is told by ch-local,
    // which loads it.
    const tellUser = (text) => {
      require('./notices').add(null, text);
      try { LOG.I(`countinghouse_settings: ${text}`); } catch (err) { /* not serving */ }
    };
    try {
      await applyChange(staged);
    } catch (err) {
      // a code, never an error's message (which can carry anything)
      const problem = String((err && typeof(err.code) === 'string' && err.code) || 'error').slice(0, 80);
      appendLine({by: by, setting: name, change: 'not applied', problem: problem});
      tellUser(`${name} not changed: the change you confirmed could not be applied (${problem})`);
      throw (err instanceof CountinghouseError) ? err : CountinghouseError.withFields('SETTING_NOT_APPLIED', {name: name, problem: problem});
    }
    if (PACK.test(name)) { if (next === true) packsThisStart.add(name); else packsThisStart.delete(name); }
    if (!PACK.test(name)) tellUser(`${name} raised from ${cliValue(name, staged.old)} to ${cliValue(name, next)} for this start (confirmed in ${staged.client.name})`);
    else { try { LOG.I(`countinghouse_settings: ${name} turned ${next === true ? 'on' : 'off'} for this start (confirmed in ${staged.client.name})`); } catch (err) { /* not serving */ } }
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

  // A shared runtime's guard (C1 part 2's review), until per-session
  // settings (B2): a session's set changes nothing, tightening included,
  // since the file is every session's and ch-local applies it to all.
  // Throws SETTING_TERMINAL_ONLY_SHARED naming the terminal command; an
  // unknown name or a value set would refuse is refused as set refuses it.
  function refuseSharedSet(name, value) {
    const e = entryOf(name);
    if (e == null) throw CountinghouseError.withFields('SETTING_UNKNOWN', {name: String(name).slice(0, 80)});
    const next = e.parse(value);
    if (next == null || Number.isNaN(next) || !validStored(e, next)) {
      throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: String(value).slice(0, 80), bounds: boundsText(e)});
    }
    throw CountinghouseError.withFields('SETTING_TERMINAL_ONLY_SHARED', {name: name, command: commandFor(name, next)});
  }

  return {get: get, set: set, confirm: confirm, refuseSharedSet, writeCounts: () => writeCounts(historyFile)};
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
// (CONTROL_APPLIES_AT_START; ch-local says so). A tightening made through
// countinghouse_settings at or under what runs applies now; one that only
// lowers a stored value still above what runs is written for the next
// start, and says so. A worker's own error texts keep the locale it started
// with.
const LOCALES = ['en-US', 'zh-CN'];
// the values this runtime started with, captured when it starts serving
// (lib/route-manager.js), never later: a value raised this start is never
// taken for the start value; a confirmed raise lifts its own (applyConfirmed)
let atStart = null;
function captureAtStart() {
  if (atStart == null) {
    atStart = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    started = Object.freeze(Object.assign({}, atStart));
  }
}
// What this runtime started with, as it was when it began serving: unlike
// atStart, never lifted by a raise confirmed since. null before a start was
// recorded, or for a value that was not a whole number then.
let started = null;
function startedWith(name) {
  return (started != null && Number.isInteger(started[name])) ? started[name] : null;
}
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
  captureAtStart();
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
function resetForTests() { atStart = null; started = null; ceilingCache = null; packsThisStart.clear(); }
function ceilingForControl(fn) { controlCeiling = fn; }
// The operator's ceiling as the control channel's backstops read it (cached
// until its file or a directory above it changes): packs in place checks its
// packs allowlist at load and reload (lib/packs-in-place.js).
function controlCeilingNow() { return controlCeiling(); }

module.exports = {create, cachedCeiling, applyConfirmed, captureAtStart, setLiveModules, packUnloaded, applyControlSet, liveOptions, broadcastLiveOptions, applyLiveOptions, resetForTests, ceilingForControl, controlCeilingNow, ALLOWLIST, INPUT_SCHEMA};
