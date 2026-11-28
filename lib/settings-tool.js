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
const fileIdentity = require('./file-identity');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const historyCut = require('./history-cut');
const options = require('./cli-options');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
// the latch's why, in the refusal's sentence (loaded once, on first use)
const conditionsWhyLib = require('./require-once')(() => require('./conditions-why'));
const LOG = require('./logger');
const {moduleLine} = require('./module-text');

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
  maxOutputBytes: {parse: size, min: MiB, max: 256 * MiB, default: 16 * MiB, guarding: true, applies: 'now', tighter: (o, n) => n <= o},
  requestTimeout: {parse: ms, min: 5000, max: 120000, default: 30000, guarding: true, applies: 'now', tighter: (o, n) => n <= o},
  moduleSandbox: {parse: String, values: ['enforce', 'audit'], default: 'enforce', guarding: true, applies: 'next start', tighter: (o, n) => n === 'enforce' || o === n},
  autoUpgrade: {parse: onOff, values: [true, false], default: false, guarding: true, applies: 'next start', tighter: (o, n) => n === false || o === n},
  upgradeCheck: {parse: String, values: ['daily', 'weekly', 'never'], default: 'daily', guarding: false, applies: 'next start'}
};
// (no setting is a pack's since M5b: a stored pack.<n> is an unknown name,
// kept on every write)
// a top-level module's on/off (#413 rev 3, section 5.1; M5b):
// enabled.<package name>, lib/module-settings.js's grammar. On/off, default
// on, guarding, applies now; off is the tighter value
const {ENABLED} = require('./module-settings');
const ENABLED_ENTRY = {parse: onOff, values: [true, false], default: true, guarding: true, applies: 'now', tighter: (o, n) => n === false || o === n};
const entryOf = (name) => (typeof(name) !== 'string' ? null
  : Object.prototype.hasOwnProperty.call(ALLOWLIST, name) ? ALLOWLIST[name] : ENABLED.test(name) ? ENABLED_ENTRY : null);
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
// A shared runtime's session may change these two for itself, in
// conversation (B2: the per-session overrides); every other setting is the
// terminal's there.
const {CAPS: SESSION_CAPS} = require('./session-settings');
// The changes one session may write to the history. The history is one
// file, read by its 64 KiB tail, and a line that names a session is shown
// to that session only: a session stepping a cap down call after call would
// push every other reader's lines out of the tail. Past this many its
// loosenings are the terminal's (asked and refused, recorded once and
// counted), and its tightenings still apply, recorded the same way: one line
// of each kind, then a count (a tightening is never refused: the final
// pass's gateway part, A5).
const MAX_SESSION_CHANGES = 32;
const PAST_BUDGET = `tightened, past this session's ${MAX_SESSION_CHANGES} changes recorded one by one`;
// (an all-sessions one: every session's line, never the asking session's
// private one -- #526's high, L3; never stored, so its label says it lasts
// until the runtime restarts)
const PAST_BUDGET_ALL = `all sessions, until the runtime restarts: ${PAST_BUDGET}`;
// (a session's own lowering undone past it: its own kind of line, never
// called a tightening -- the medium on the undo)
const PAST_BUDGET_UNDO = `its own lowering undone, past this session's ${MAX_SESSION_CHANGES} changes recorded one by one`;
const APPLIED = (change) => change === PAST_BUDGET || change === PAST_BUDGET_ALL || change === PAST_BUDGET_UNDO;
const sessionChanges = new Map();   // session id -> changes it has recorded
// A session's end: the counts of its repeated requests are written, and
// nothing of it is kept (lib/sessions.js close).
function forgetSession(session) {
  sessionChanges.delete(session);
  stagedModuleForms.delete(session);
  for (const bySession of MODULE_LINES.values()) bySession.delete(session);
  for (const [historyFile, pending] of UNCONFIRMED) {
    if (![...pending.values()].some((p) => p.session === session)) continue;
    writeCounts(historyFile, session);
    for (const [kind, p] of [...pending]) if (p.session === session) pending.delete(kind);
  }
}
// A module setting's line made in a session: every session's to read
// (seenOf), the marker in `scope`, never in `change` (a real change has no
// change label: ch-local's outside-edits replays it as one)
const EVERY_SESSION = 'every session';
const everySession = (session) => (session != null ? {session, scope: EVERY_SESSION} : {});
// A module setting's form, as staged: the declaration that read its value
// (store key: the session, '' for the runtime's own store; one form a
// store), so its answer is verified against the change as staged, even
// once the module has unloaded or reloaded with another declaration
const stagedModuleForms = new Map();
const storeKeyOf = (session) => (session != null ? session : '');
// the scope a line carries, when the request it records was for all sessions
const scoped = (scope) => (scope != null ? {scope: String(scope)} : {});

// Every line written in a session's path names that session (B5 Task 3): a
// line with no session is every session's to read (readHistory), so a writer
// that forgot the field would show one session's request to all of them. The
// path is a shared session's set and confirm (inSessionPath, entered by the
// tool), and the session's end and replays (recordUnanswered,
// recordReplayed, given the session). A line that names no session, or
// another one, is not written: the writer throws.
const SESSION_PATH = new (require('async_hooks').AsyncLocalStorage)();
const UNNAMED = 'a history line written in a session\'s path names that session';
function namesItsSession(line, session) {
  if (typeof(session) !== 'string' || session === '' || line == null || line.session !== session) throw new Error(UNNAMED);
}
// fn run as session's path: every line written in it names that session
const inSessionPath = (session, fn) => SESSION_PATH.run({session: session}, fn);
// One line, checked against the path it is written in. (writeCounts writes
// what recordAsked recorded, each line under its own session: recordAsked,
// where the session is taken, is where it is checked.)
function checkPath(line) {
  const p = SESSION_PATH.getStore();
  if (p !== undefined) namesItsSession(line, p.session);
}
// (a module.* line's values cut as section 4.2 says: lib/history-cut.js)
function appendHistoryLine(historyFile, line) {
  checkPath(line);
  fs.appendFileSync(historyFile, `${JSON.stringify(Object.assign({at: new Date().toISOString()}, historyCut.cutLine(line)))}\n`);
}
// A session's forms that ended unanswered and were not yet said (the one
// pending at its end, any its timer expired since it last asked): recorded
// as the session's (lib/sessions.js close, with lib/settings-confirm.js
// forget's answer).
function recordUnanswered(session, forms) {
  namesItsSession({session: session}, session);
  if (options.settingsFile == null || !Array.isArray(forms) || forms.length === 0) return;
  const historyFile = path.join(path.dirname(options.settingsFile), 'history.jsonl');
  try {
    for (const gone of forms) {
      fs.appendFileSync(historyFile, `${JSON.stringify(historyCut.cutLine(Object.assign({at: new Date().toISOString(), by: 'settings tool', setting: gone.name, asked: gone.next, change: 'expired', session: session}, scoped(gone.scope))))}\n`);
    }
  } catch (err) { /* a history that cannot be written says nothing more */ }
}
// What a set (and its retry) says the change is for: nothing, or
// 'all-sessions' (B2 Task 5b: the user asked, in one session of a shared
// runtime, to change a cap for every session). Anything else is no scope;
// and a runtime with one session takes none.
function scopeOf(ctx) {
  if (ctx == null || ctx.scope === undefined) return null;
  if (ctx.scope !== 'all-sessions') throw new CountinghouseError('ARGUMENTS_INVALID', 'scope is all-sessions, or not given');
  if (ctx.shared !== true) throw new CountinghouseError('ARGUMENTS_INVALID', 'scope is for a shared runtime\'s sessions; this runtime has one');
  return 'all-sessions';
}
// the session a request is made in, when the runtime is a shared one
const sharedSession = (ctx) => ((ctx != null && ctx.shared === true && typeof(ctx.session) === 'string') ? ctx.session : null);
const conversationMayAsk = (name) => name === 'maxOutputBytes' || name === 'requestTimeout' || ENABLED.test(name);

// A value as the ch-local command takes it: 64MiB, 45s, on.
function cliValue(name, v) {
  if (name === 'maxOutputBytes') return (v % MiB === 0) ? `${v / MiB}MiB` : `${v}B`;
  if (name === 'requestTimeout') return (v % 1000 === 0) ? `${v / 1000}s` : `${v}ms`;
  return String(shown(v));
}
// (through ch-local's launcher where it gave one: lib/held-back.js
// terminalCommand; the dry run's walk step 9)
const {terminalCommand, ready: heldBackReady} = require('./held-back');
const commandFor = (name, v) => terminalCommand(`settings set ${name} ${cliValue(name, v)}`);
// The sentence a no-form answer gains when the asking session's own lower value is why the terminal command it names
// would not move it (withOwnLower): the lead, then one of the three next steps, then, where it applies, the start
// value's wait. Business's words (2026-11-28), pinned word for word in validation 04.
const OWN_LOWER = Object.freeze({
  lead: 'This session keeps its own lower value ({current}), so that command alone won\'t change {name} here: ',
  restart: 'after it, restart your client to get a session with the new value.',
  ask: 'after it, ask again here to raise this session\'s value too.',
  paused: 'after it, ask again here once the pause on new questions ends (at most 30 minutes), or restart your client.',
  later: ' A value above what this runtime started with takes effect when it next starts.'
});

// ---- module settings (the module-level configuration design, section 4.4; M2b)
// module.<package>.<setting>, the last dot splitting the setting (a
// package name may hold dots; a setting's never does)
const {MODULE_SETTING, ownWords} = require('./module-settings');
// get's module rows a call, at most
const MODULE_ROWS = 64;
// the command a module setting is changed by at a terminal (no value: a
// hint never carries one)
const moduleCommandFor = (pkg, setting) => terminalCommand(`settings set ${pkg}.${setting}`);
// a value as a client gives it (text for a number, on/off) -> the value
// the declaration's type takes, or the text itself (checkValue refuses it)
function moduleValueOf(decl, value) {
  if (decl.type === 'boolean') { const v = onOff(value === 'true' ? true : value === 'false' ? false : value); return v == null ? value : v; }
  if ((decl.type === 'integer' || decl.type === 'number') && typeof(value) === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return value;
}
// a value as a declaration reads it, checked (net: what the module was
// granted): -> checkValue's answer, with the value it was checked as
function checkedWith(decl, net, value) {
  const v = moduleValueOf(decl, value);
  return Object.assign({as: v}, require('./module-settings').checkValue(decl, v, {net}));
}
// what a declaration allows, as get shows it
function moduleBounds(decl) {
  if (decl.type === 'enum') return {enum: decl.values.slice()};
  if (decl.type === 'boolean') return {enum: [true, false]};
  if (decl.type === 'integer' || decl.type === 'number') {
    const b = {};
    if (decl.min != null) b.min = decl.min;
    if (decl.max != null) b.max = decl.max;
    return b;
  }
  return Object.assign(decl.format != null ? {format: decl.format} : {}, {maxLength: decl.maxLength});
}
// how a module setting may change in conversation: the ceiling first
// (fixed; conversation off, or a ceiling that cannot be trusted: the
// terminal's), then the author's confirm and every string (section 4.4)
function moduleChanges(c, pkg, setting, decl) {
  if (c != null && c.state !== 'none' && c.state !== 'trusted') return 'at a terminal only';
  const rule = require('./settings-ceiling').moduleSettingRule(c, pkg, setting);
  if (rule != null && Object.prototype.hasOwnProperty.call(rule, 'fixed')) return 'fixed by the operator';
  if ((rule != null && rule.conversation === false) || (c != null && c.state === 'trusted' && c.ceiling.conversation === false)) return 'at a terminal only';
  if ((rule != null && rule.confirm === true) || require('./module-settings').confirmRule(decl) === 'confirm') return 'needs your confirmation';
  return 'on request';
}
// A module setting's form (section 4.4): the runtime's sentence, never the
// author's or the agent's: the package and its version, the setting's key,
// the old and new values in quotes (each cut to 200 characters, "(cut)"),
// for every session of the user; the author's title, when there is one,
// labelled as the module's own words.
const FORM_CUT = 200;
function cutValue(v) {
  const text = (v == null) ? '' : (typeof(v) === 'string' ? v : JSON.stringify(v));
  return text.length > FORM_CUT ? `${text.slice(0, FORM_CUT)} (cut)` : text;
}
function moduleFormFor(ch, name) {
  // (the author's title, cleaned as module text: module-settings ownWords)
  const own = ownWords(ch.decl);
  const title = own.title != null ? own.title : null;
  const version = ch.version != null ? ` ${ch.version}` : '';
  const message = `Change ${ch.pkg}${version}'s setting ${ch.setting} from "${cutValue(ch.old)}" to "${cutValue(ch.next)}"? This applies to every session of this user.${title != null ? ` The module describes it, in its own words, as: "${title}".` : ''}`;
  return {method: 'elicitation/create', params: {mode: 'form', message,
    requestedSchema: {type: 'object', properties: {approve: {type: 'boolean', title: 'Allow'}}, required: ['approve']}}};
}

// a cursor: the offset of the next paged row, and the generation of the
// rows it was cut from (a hash of their names), opaque to the client. A
// list that changed since is SETTING_CURSOR_STALE, so no row is skipped or
// repeated (#449's high review, round 3, 6)
const generationOf = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows.map((r) => r.name))).digest('hex').slice(0, 12);
const cursorOf = (offset, gen) => Buffer.from(`m${offset}.${gen}`, 'utf8').toString('base64url');
// -> {offset, gen} (gen null for no cursor), or throws SETTING_CURSOR_INVALID
function parseCursor(cursor) {
  if (cursor == null) return {offset: 0, gen: null};
  const text = (typeof(cursor) === 'string' && cursor.length <= 32) ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
  const m = /^m(\d{1,6})\.([0-9a-f]{12})$/.exec(text);
  if (m == null) throw new CountinghouseError('SETTING_CURSOR_INVALID');
  return {offset: Number(m[1]), gen: m[2]};
}

// Loosenings asked for and not made, per history file, for this start (the
// gateway makes a tool per call, so this is not the tool's own): those that
// need the user's confirmation, and those refused as terminal only (the
// sandbox, automatic upgrades: the strongest sign of an injected prompt).
// Spec sections 2 and 5: each kind (a cap, the timeout, any pack, the
// sandbox, automatic upgrades) is recorded once, whatever value or pack is
// asked for; asked again it only counts, and the count is written, under
// the lock, before the next change recorded or when the runtime ends. A
// module setting is its own (each one the user is refused is said), so for
// module settings the bound is per window instead: per session (the
// runtime's own included), at most MODULE_LINES_PER_WINDOW (8) settings'
// lines in WINDOW_MS, the rest (distinct settings) one '... and N more'
// line, written at most once a window and once at the end. So a start
// writes at most five such lines for the runtime's own kinds, and per
// session per window at most nine for module settings (and one at its end),
// with their counts: repeated
// requests never push older history out, and a session's flood in a
// window is far short of the HISTORY_SHOWN (50) tail a reader is shown.
const UNCONFIRMED = new Map();   // historyFile -> Map(kind -> {setting, by, count, written})
// The module settings' bound (above): the times each session's distinct
// module-setting lines were written. historyFile -> Map(session key -> [at])
const MODULE_LINES_PER_WINDOW = 8;
const MODULE_LINES = new Map();
// one kind per setting, every pack.<name> one (as decline locks are kept)
const {kindOf, WINDOW_MS} = require('./settings-confirm');
function pendingFor(historyFile) {
  if (!UNCONFIRMED.has(historyFile)) UNCONFIRMED.set(historyFile, new Map());
  return UNCONFIRMED.get(historyFile);
}
// The counts not yet written, as history lines (called with the lock held, or
// at exit); only: one session's (at its end).
// final: at a session's end or the runtime's exit, when every count is said
function writeCounts(historyFile, only = null, final = only != null) {
  const pending = UNCONFIRMED.get(historyFile);
  if (pending == null) return;
  for (const p of pending.values()) {
    if (p.count <= p.written || (only != null && p.session !== only)) continue;
    // the module settings' 'more' line: once a window, then at the end (its
    // bound: a flood adds at most one line a window, and one at the end)
    if (p.more === true && !final && p.flushedAt != null && p.clock() - p.flushedAt < WINDOW_MS) continue;
    // (an applied change counted past the budget: how many more, and the
    // value it came to, never "asked again": #526's high, L3)
    const line = {at: new Date().toISOString(), by: p.by, setting: p.setting,
      change: p.more === true ? `... and ${p.count - p.written} more module settings refused`
        : p.applied === true ? `${p.change}, ${p.count - p.written} more, the latest as \`latest\`` : `${p.change}, asked again`, count: p.count - p.written};
    if (p.applied === true) line.latest = p.latest;
    // a session's request, counted for it (get shows it to that session only)
    if (p.session != null) line.session = p.session;
    if (p.scope != null) line.scope = p.scope;
    try {
      fs.appendFileSync(historyFile, `${JSON.stringify(line)}\n`);
      p.written = p.count;
      if (p.more === true) p.flushedAt = p.clock();
    } catch (err) { /* said at the next */ }
  }
}
process.once('exit', () => { for (const f of UNCONFIRMED.keys()) writeCounts(f, null, true); });

// The operator's ceiling (part 3, section 4): a loosening it forbids, or a
// value above it, is SETTING_ABOVE_CEILING; a ceiling file that cannot be
// trusted refuses every loosening (SETTING_CEILING_UNTRUSTED). A tightening
// of what the runtime runs with is never refused by it; a write that only
// tightens a stored value, and is above both the ceiling and what runs, is
// (set: it would put a value above the ceiling in the file).
// A module's on/off is the ceiling's modules list's, never forbid's.
const CEILING_KIND = (name) => (ENABLED.test(name) ? null : name);
// Read once per process, and again when the file changes (on Windows at most
// every 5 minutes otherwise: an ACL change does not touch the file's times);
// never per call, which on Windows spawns PowerShell.
let ceilingCache = null;   // {key, at, value}
// fn(ceiling) for a ceiling read again that differs from the last one read
const ceilingListeners = new Set();
function onCeilingChange(fn) { ceilingListeners.add(fn); return () => ceilingListeners.delete(fn); }
// On Windows a read (it spawns PowerShell) is taken as current this long: a
// little under the watch's 5 minutes (watchCeiling), so every tick of the
// watch reads again, and a change is never left to the tick after (the
// review of #284).
const WINDOWS_CEILING_AGE_MS = 5 * 60 * 1000 - 10 * 1000;
// {cacheOnly}: never read (spawning nothing): the cached value while its key
// is the file's (the Windows age rule aside: a value read just before the
// lock is current), else undefined (inside settings.lock, where nothing slow
// runs). platform and now: a test's.
function cachedCeiling(read, {cacheOnly = false, platform = process.platform, now = Date.now} = {}) {
  let key = 'none';
  // ctime too: a rewrite in place to the same size with its mtime put back
  // (touch -r, cp -p) changes nothing else (the review of #284)
  // (read as bigints: the exact ino, and times to the nanosecond;
  // lib/file-identity.js)
  const stamp = (st) => `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.mode}:${st.uid}`;
  try {
    const file = require('./settings-ceiling').ceilingFile();
    const parts = [];
    try { parts.push(stamp(fs.lstatSync(file, fileIdentity.BIG))); } catch (err) { if (err == null || err.code !== 'ENOENT') throw err; parts.push('none'); }
    // on POSIX each directory above it too, so a later chmod or chown of a
    // parent is seen (the review of #199)
    if (platform !== 'win32') {
      let d;
      try { d = fs.realpathSync.native(path.dirname(file)); } catch (err) { d = null; }
      for (; d != null; d = path.dirname(d) === d ? null : path.dirname(d)) {
        try { parts.push(`${d}=${stamp(fs.lstatSync(d, fileIdentity.BIG))}`); } catch (err) { parts.push(`${d}=${err && err.code}`); }
      }
    }
    key = parts.join('|');
  } catch (err) { key = `error:${err && err.code}`; }
  if (cacheOnly) return ceilingCache != null && ceilingCache.key === key ? ceilingCache.value : undefined;
  const stale = ceilingCache == null || ceilingCache.key !== key || (platform === 'win32' && now() - ceilingCache.at >= WINDOWS_CEILING_AGE_MS);
  if (stale) {
    const before = (ceilingCache != null) ? JSON.stringify(ceilingCache.value) : undefined;
    ceilingCache = {key: key, at: now(), value: read()};
    // a re-read ceiling: every session's stored loosenings are clamped to it
    // (lib/session-settings.js ceilingSeen; idle sessions too)
    try { require('./session-settings').ceilingSeen(ceilingCache.value); } catch (e) { /* not this runtime's concern */ }
    // and one that changed is told to whoever binds by it (the modules'
    // settings: lib/settings-reread.js, through lib/route-manager.js)
    if (before !== undefined && JSON.stringify(ceilingCache.value) !== before) {
      for (const fn of ceilingListeners) { try { fn(ceilingCache.value); } catch (e) { /* the listener's own concern */ } }
    }
  }
  return ceilingCache.value;
}
// A session's tightenings replayed by its shim after a restart, as they were
// applied (lib/sessions.js replayed): one history line a setting, marked as
// a replay and as that session's, so its `get` shows why the value holds
// (the line made when it was first set names the session it had then). The
// client is sent no notice: it asked for them itself. Best effort: a
// tightening the history cannot hold is applied all the same.
// changes: [{name, old, next}]
// The same for what the daemon's table restored to a session after a
// runtime restart (lib/session-state.js): by 'restore', and said as that.
function recordReplayed(session, changes, {by = 'replay', change = 'this session (replayed after a restart)'} = {}) {
  namesItsSession({session: session}, session);
  if (options.settingsFile == null) return;
  const historyFile = path.join(path.dirname(options.settingsFile), 'history.jsonl');
  for (const c of changes) {
    const line = {at: new Date().toISOString(), by: by, setting: c.name, old: c.old, new: c.next, change: change, session: session};
    try {
      fs.appendFileSync(historyFile, `${JSON.stringify(line)}\n`);
      // its lines count toward what a session may write to the history
      // every session reads (MAX_SESSION_CHANGES)
      sessionChanges.set(session, (sessionChanges.get(session) || 0) + 1);
    } catch (err) { /* said nowhere: the value holds */ }
  }
}
// The ceiling read once when the shared runtime starts serving sessions
// (lib/route-manager.js): a call's path reads the cache only, never the
// file, so until something has read it the ceiling is not known and a call
// is held to the default alone (lib/session-settings.js underCeiling). A
// ceiling that cannot be read stays unknown, as before. read: a test's.
function primeCeiling(read = () => require('./settings-ceiling').readCeiling(), {platform, now} = {}) {
  try { cachedCeiling(read, {platform, now}); } catch (err) { /* not known: the last one read stays in force */ }
}
// The shared runtime's watch on the ceiling (the reviewer's ruling on #284):
// one lowered while it runs comes to bound calls without anyone calling the
// settings tool. Every tick asks the cache, which reads the file again only
// when it is stale: on POSIX that check is a few stats (the file and each
// directory above it), so it runs every 10 s; on Windows a read spawns
// PowerShell and the cache takes it as current for 5 minutes, so it runs
// every 5 minutes. A change read calls ceilingSeen (cachedCeiling). The
// timer never keeps the process alive. -> stop(). every, clear, platform,
// now, read: a test's.
const CEILING_WATCH_MS = {posix: 10 * 1000, win32: 5 * 60 * 1000};
function watchCeiling({read = () => require('./settings-ceiling').readCeiling(), platform = process.platform, now,
  every = (fn, ms) => { const t = setInterval(fn, ms); if (typeof(t.unref) === 'function') t.unref(); return t; }, clear = clearInterval} = {}) {
  const handle = every(() => primeCeiling(read, {platform, now}), platform === 'win32' ? CEILING_WATCH_MS.win32 : CEILING_WATCH_MS.posix);
  return () => clear(handle);
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
  // a module turned on: the ceiling's modules list, when it has one (#413
  // rev 3, section 8; one that still holds packs is not trusted at all,
  // lib/settings-ceiling.js); turned off is never refused
  const en = ENABLED.exec(name);
  if (en != null && next === true) {
    if (Array.isArray(c.modules) && !c.modules.includes(en[1])) return {code: 'SETTING_FORBIDDEN_BY_CEILING', fields: {name: name, value: cliValue(name, next)}};
  }
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
  maxOutputBytes: (o, n) => `Allow countinghouse tools to return up to ${n} per call (now ${o})? This applies until your client restarts countinghouse.`,
  requestTimeout: (o, n) => `Allow countinghouse tool calls to run for up to ${n} (now ${o})? This applies until your client restarts countinghouse.`,
  // a module turned on for every session of the user (#413 rev 3, section 5.3)
  enabled: (m, v) => `Turn on ${m} ${v} in countinghouse for all your sessions? It stays on, now and after a restart, until it is turned off.`,
  // a shared runtime's session (B2 Task 5): the change is that session's only
  session: {
    maxOutputBytes: (o, n) => `Allow countinghouse tools to return up to ${n} per call in this session (now ${o})? This applies to this session only, until it ends.`,
    requestTimeout: (o, n) => `Allow countinghouse tool calls to run for up to ${n} in this session (now ${o})? This applies to this session only, until it ends.`
  },
  // one session asking for all (B2 Task 5b): a global change, kept
  all: {
    maxOutputBytes: (o, n) => `Allow countinghouse tools in all your sessions to return up to ${n} per call (now ${o})? This changes the setting for every session, now and after a restart.`,
    requestTimeout: (o, n) => `Allow countinghouse tool calls in all your sessions to run for up to ${n} (now ${o})? This changes the setting for every session, now and after a restart.`
  },
  title: 'Approve'
};
// The runtime's effective value of a setting: a cap is what this runtime
// runs with (raised this start, or the start's), not the file's.
function effectiveOf(values, name) {
  if (isCap(name) && Number.isInteger(options[name])) return options[name];
  return valueOf(values, name);
}
// the terminal command that turns a module on or off
const enabledCommand = (pkg, v) => terminalCommand(`settings set enabled.${pkg} ${v === true ? 'on' : 'off'}`);
// the loaded top-level modules (loadedTops' rows) that call pkg: whose
// closure holds it; they go with it
const callersIn = (pkg, tops) => tops.filter((t) => t.name !== pkg && Array.isArray(t.modules) && t.modules.includes(pkg)).map((t) => t.name).sort();

// The top-level modules of ch-local's record (modules.json), by ch-local's
// own rule (its lib/module-roles.js topLevel, lib/packs.js packScenario):
// each pack's scenario, of the pack's modules the first that the record
// gives role scenario, else the pack's first; only one the record holds.
// Any other module is a part (#449's high review, 1; the vectors'
// topLevelModules pin it for both repos). -> Set(package)
const isRecordObj = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
function topLevelModules(rec) {
  const out = new Set();
  if (!isRecordObj(rec) || !isRecordObj(rec.modules) || !isRecordObj(rec.packs)) return out;
  for (const p of Object.values(rec.packs)) {
    const scenario = scenarioOfPack(rec, p);
    if (scenario != null) out.add(scenario);
  }
  return out;
}
// a pack's scenario module by that rule: of its modules the first the record
// gives role scenario, else its first; only one the record holds -> or null
function scenarioOfPack(rec, p) {
  if (!isRecordObj(rec) || !isRecordObj(rec.modules) || !isRecordObj(p) || !isRecordObj(p.modules)) return null;
  // (own properties only, as ch-local reads them: #449's high review, round 3, 7)
  const holds = (m) => Object.hasOwn(rec.modules, m) && rec.modules[m] != null;
  const packages = Object.keys(p.modules);
  const scenario = packages.find((m) => holds(m) && isRecordObj(rec.modules[m]) && Object.hasOwn(rec.modules[m], 'role') && rec.modules[m].role === 'scenario') || packages[0];
  return (scenario != null && holds(scenario)) ? scenario : null;
}
// The installed modules, as ch-local's record beside the settings file
// (user-writable) gives them: Map(package -> {version (strict, or null),
// top: whether it is top-level}), null with no record, UNREADABLE for
// one that is there and cannot be read. The record is modules.json
// (module-level configuration, L1a); packs.json, the record before it, is
// no longer read (M6): ch-local migrates a home from before (#413 rev 3
// section 10).
const UNREADABLE = Symbol('unreadable');
function installedModules(dir) {
  const strict = (v) => (typeof(v) === 'string' && require('./elicitation-clients').isPlainVersion(v) ? v : null);
  const isObj = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(dir, 'modules.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') return UNREADABLE;
  }
  const out = new Map();
  if (rec != null) {
    if (!isObj(rec) || !isObj(rec.modules) || !isObj(rec.packs)) return UNREADABLE;
    const tops = topLevelModules(rec);
    for (const [pkg, m] of Object.entries(rec.modules)) {
      if (isObj(m)) out.set(pkg, {version: strict(m.version), top: tops.has(pkg)});
    }
    return out;
  }
  // (no record: nothing installed)
  return null;
}
// The installed packs, as ch-local's record (modules.json) beside the
// settings file gives them (countinghouse_overview: B-firstrun): [{pack,
// scenario}], each pack with its scenario module by topLevelModules' rule,
// sorted by name; a name that is not a package name left out. null with
// no record, UNREADABLE for one that is there and cannot be read.
function installedPacks(dir) {
  const isPackage = (n) => require('./remote/credentials').isPackage(n);
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(dir, 'modules.json'), 'utf8'));
  } catch (e) {
    return e.code === 'ENOENT' ? null : UNREADABLE;
  }
  if (!isRecordObj(rec) || !isRecordObj(rec.modules) || !isRecordObj(rec.packs)) return UNREADABLE;
  const out = [];
  for (const [pack, p] of Object.entries(rec.packs)) {
    if (!isPackage(pack)) continue;
    // (each pack's own scenario, by topLevelModules' rule: the medium on B-firstrun, 2)
    const scenario = scenarioOfPack(rec, p);
    if (scenario != null && isPackage(scenario)) out.push({pack, scenario});
  }
  return out.sort((a, b) => (a.pack < b.pack ? -1 : a.pack > b.pack ? 1 : 0));
}
// The user's own modules, as ch-local's own.json beside the settings file
// names them (B-own-runtime; the own-modules design §2.1-2.2: {v: 1,
// modules: {<package>: {tree, version, friendlyName, addedAt, from}}}):
// [{name, from, tree}], from the absolute folder it was added from (or null),
// tree the files' hash ch-local recorded, 64 lowercase hex (or null: E10),
// sorted by name; a name that is not a package name left out. null with no
// own.json, UNREADABLE for one that is there and cannot be read.
function installedOwn(dir) {
  const isPackage = (n) => require('./remote/credentials').isPackage(n);
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(dir, 'own.json'), 'utf8'));
  } catch (e) {
    return e.code === 'ENOENT' ? null : UNREADABLE;
  }
  if (!isRecordObj(rec) || rec.v !== 1 || !isRecordObj(rec.modules)) return UNREADABLE;
  const out = [];
  for (const [name, m] of Object.entries(rec.modules)) {
    if (!isPackage(name)) continue;
    const from = (isRecordObj(m) && typeof(m.from) === 'string' && path.isAbsolute(m.from) && m.from.length <= 4096) ? m.from : null;
    const tree = (isRecordObj(m) && typeof(m.tree) === 'string' && /^[0-9a-f]{64}$/.test(m.tree)) ? m.tree : null;
    out.push({name, from, tree});
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
// The last update check the user asked for (`ch-local upgrade --check`), as
// ch-local left it beside the settings file (upgrade-available.json, written
// whole: {v: 1, checkedAt, installed, available|null, major, breaking,
// plugin: {installed|null, latest}|null}; the maintainer's (d), the own-modules design
// §2.7) -> {checkedAt, installed, available, major, breaking, pluginLatest}
// (the plugin's latest only when the installed release's plugin is known
// and older: none when it is not, as ch-local's pluginStep), null with
// none, or with one this runtime can't tie to the ch-local now installed
// (made before an upgrade or a rollback, made with no version recorded, or a
// record that can't be read), or UNREADABLE (said, never silent). Every
// field is held to what ch-local's check writes (ch-local lib/upgrade.js,
// lib/npm-upgrade.js: strict x.y.z, newer, major, breaking; an up-to-date
// check names no plugin). Read only, and plainly: no link, no FIFO, one
// name, bounded (#499's readPlainFile); the runtime never checks the network.
// (A's mediums on the update line)
const STRICT_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UPDATE_MAX = 4 * 1024;
const RECORD_MAX = 4 * 1024 * 1024;
const versionParts = (v) => v.split('.').map(Number);
const newerVersion = (a, b) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
// (ch-local's breaking(): a 0.x minor or a 0.0.x patch step)
const breakingStep = (a, b) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  if (x[0] !== 0 || y[0] !== 0) return false;
  return x[1] !== y[1] || (x[1] === 0 && x[2] !== y[2]);
};
// (a real instant, ending as written, and not past tomorrow by this clock)
const realInstant = (t, now) => {
  const ms = Date.parse(t);
  return Number.isFinite(ms) && new Date(ms).toISOString() === t && ms <= now + 24 * 3600 * 1000;
};
function upgradeAvailable(dir, now = Date.now()) {
  const plain = require('./module-tree-check').readPlainFile;
  let rec = null;
  try {
    rec = JSON.parse(plain(path.join(dir, 'upgrade-available.json'), UPDATE_MAX).toString('utf8'));
  } catch (e) {
    return e.code === 'ENOENT' ? null : UNREADABLE;
  }
  const version = (v) => typeof(v) === 'string' && STRICT_VERSION.test(v);
  if (!isRecordObj(rec) || rec.v !== 1 || typeof(rec.checkedAt) !== 'string' || !ISO_SHAPE.test(rec.checkedAt) || !realInstant(rec.checkedAt, now)) return UNREADABLE;
  if (!(rec.installed === null || version(rec.installed)) || !(rec.available === null || version(rec.available)) || typeof(rec.major) !== 'boolean' || typeof(rec.breaking) !== 'boolean') return UNREADABLE;
  let pluginLatest = null;
  if (rec.available === null) {
    // (up to date: nothing else to say, as ch-local writes it)
    if (rec.major || rec.breaking || rec.plugin !== null) return UNREADABLE;
  } else {
    if (rec.installed === null || !newerVersion(rec.available, rec.installed) || rec.major !== (versionParts(rec.available)[0] !== versionParts(rec.installed)[0]) ||
      rec.breaking !== breakingStep(rec.available, rec.installed)) return UNREADABLE;
    if (rec.plugin !== null) {
      if (!isRecordObj(rec.plugin) || !version(rec.plugin.latest) || !(rec.plugin.installed === null || version(rec.plugin.installed))) return UNREADABLE;
      // (only when the installed release's plugin is known and older, as
      // ch-local's own upgrade says it: lib/upgrade.js pluginStep)
      if (rec.plugin.installed !== null && newerVersion(rec.plugin.latest, rec.plugin.installed)) pluginLatest = rec.plugin.latest;
    }
  }
  // (a check that names no version, or one this runtime can't tie to the
  // ch-local now installed -- an upgrade or a rollback since, or a record it
  // can't read -- says nothing of it: no line; ch-local removes it on an
  // install and a rollback too)
  if (rec.installed === null) return null;
  const installedNow = installedSelf(dir);
  if (installedNow == null || installedNow !== rec.installed) return null;
  return {checkedAt: rec.checkedAt, installed: rec.installed, available: rec.available, major: rec.major, breaking: rec.breaking, pluginLatest};
}
// ch-local's own version as its record names it (modules.json's
// runtime.versions), read plainly, or null when it can't be read
function installedSelf(dir) {
  try {
    const rec = JSON.parse(require('./module-tree-check').readPlainFile(path.join(dir, 'modules.json'), RECORD_MAX).toString('utf8'));
    const v = isRecordObj(rec) && isRecordObj(rec.runtime) && isRecordObj(rec.runtime.versions) ? rec.runtime.versions['@countinghouse/ch-local'] : null;
    return typeof(v) === 'string' && STRICT_VERSION.test(v) ? v : null;
  } catch (e) {
    return null;
  }
}
// session: the form of a shared runtime's session (the two caps), which
// says the change is that session's only; all: the form of a change one
// session asks for all sessions, which names them all
function formFor(name, old, next, version, {session = false, all = false} = {}) {
  const text = FORM_TEXT;
  // a module turned on: every session's, whatever the scope (one sentence)
  const en = ENABLED.exec(name);
  const message = en != null ? text.enabled(en[1], version)
    : (all ? text.all : session ? text.session : text)[name](cliValue(name, old), cliValue(name, next));
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
// - requestTimeout: set, and every worker told (no restart).
// (A module's on/off is never applied here: it is written to the file, and
// ch-local loads or unloads the module: #413 rev 3, section 5.3.)
// A raise lifts the control set's start cap for this value only, so a later
// set from ch-local up to it applies.
async function applyConfirmed(staged, deps) {
  const name = String(staged.name);
  const notApplied = (problem) => CountinghouseError.withFields('SETTING_NOT_APPLIED', {name: name, problem: String(problem).slice(0, 80)});
  // the values this runtime started with, before anything here changes one
  captureAtStart();
  const loosening = staged.next > staged.old;
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
async function defaultApplyChange(staged) {
  return applyConfirmed(staged, liveDeps());
}

const HISTORY_SHOWN = 50;
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 5000;
// how long a module setting's write waits for its apply on the control
// channel's chain before it answers written (applied when its turn comes)
const APPLY_WAIT_MS = 10000;

// (its reset command through ch-local's launcher where it gave one: the
// tool's own answers are built after the held-back read; a module's load
// and a reread keep the problem alone, lib/module-settings.js
// settingsFileProblem)
function fileInvalid(problem) {
  return CountinghouseError.withFields('SETTINGS_FILE_INVALID', {problem: problem, command: terminalCommand('settings reset')});
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

// The last HISTORY_SHOWN entries of history.jsonl a reader may see, oldest
// first, each with only the fields the model is shown: never ch-local's host
// or pid. Read back from its end (it only grows) in steps of
// HISTORY_TAIL_BYTES, until there are HISTORY_SHOWN, or the file's start, or
// HISTORY_MAX_BYTES read (B5 Task 3): other sessions' lines may fill a step,
// but can't push a session's own, or a line for every session, out of its
// view. Under --stdio nothing is dropped, so the first step holds them, as
// before.
const HISTORY_TAIL_BYTES = 64 * 1024;
const HISTORY_MAX_BYTES = 1024 * 1024;
// asked: a loosening asked for and not confirmed (never old/new, which say a change made)
// (a cut value shows its <field>Sha256 beside it, so a reader knows it is
// not the whole: section 4.2, lib/history-cut.js)
const HISTORY_FIELDS = ['at', 'by', 'setting', 'old', 'oldSha256', 'new', 'newSha256', 'change', 'loosened', 'problem', 'notice', 'asked', 'askedSha256', 'count', 'latest', 'confirmed', 'scope'];
// session: a line that names a session (a change or a request made in a
// shared runtime's session; B2 Task 4) is shown to that session only, and
// its id to no one; a line with none is everyone's.
function readHistory(file, session = null) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (err) { return []; }
  let shown = [];
  try {
    let end = fs.fstatSync(fd).size;
    let read = 0;
    // the bytes of the line the last step began inside, kept for the next
    // (split at a newline byte, which UTF-8 never has inside a character)
    let carry = Buffer.alloc(0);
    while (end > 0 && read < HISTORY_MAX_BYTES && shown.length < HISTORY_SHOWN) {
      const length = Math.min(end, HISTORY_TAIL_BYTES, HISTORY_MAX_BYTES - read);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, end - length);
      end -= length;
      read += length;
      let chunk = Buffer.concat([buf, carry]);
      carry = Buffer.alloc(0);
      if (end > 0) {
        // a line cut by the step's start waits for the next step (at the
        // bound, it is dropped)
        const nl = chunk.indexOf(0x0a);
        if (nl < 0) { carry = chunk; continue; }
        carry = chunk.subarray(0, nl);
        chunk = chunk.subarray(nl + 1);
      }
      shown = seenOf(chunk.toString('utf8'), session).concat(shown);
    }
  } catch (err) {
    return [];
  } finally {
    fs.closeSync(fd);
  }
  return shown.slice(-HISTORY_SHOWN);
}
// The lines of one step a reader may see, oldest first.
function seenOf(text, session) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry;
    try { entry = JSON.parse(line); } catch (err) { continue; }   // a torn line
    if (entry == null || typeof(entry) !== 'object') continue;
    // a line that names a session is that session's only, but for a change
    // made for all sessions (B2 Task 5b), which is every session's to read,
    // as a terminal change is (the session's id is shown to no one)
    const forAll = (typeof(entry.change) === 'string' && entry.change.startsWith('all sessions')) || entry.scope === EVERY_SESSION;
    if (entry.session !== undefined && entry.session !== session && !forAll) continue;
    out.push(Object.fromEntries(HISTORY_FIELDS.filter((k) => entry[k] !== undefined).map((k) => [k, entry[k]])));
  }
  return out;
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
    // (as bigints: the same lock is told apart from another holder's by its
    // exact dev and ino -- a Windows file index past 2^53 loses its low
    // bits as a Number)
    try { st = fs.statSync(lock, fileIdentity.BIG); } catch (err) { st = null; }
    if (st != null && Date.now() - Number(st.mtimeMs) > LOCK_STALE_MS) {
      try { if (fileIdentity.sameFile(fs.statSync(lock, fileIdentity.BIG), st)) fs.rmSync(lock, {force: true}); } catch (err) { /* gone */ }
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
// sessionClient, growValidators: a test's (a shared runtime's session: the
// tested-client check of its request, and the validators' growth before a
// raised output cap applies).
function create({file, lockWaitMs = LOCK_WAIT_MS, applyWaitMs = APPLY_WAIT_MS, clock = () => Date.now(), ceiling = (o) => cachedCeiling(() => require('./settings-ceiling').readCeiling(), o),
  allowlist = require('./elicitation-clients').ALLOWLIST, mayElicit = (ctx) => defaultMayElicit(ctx, allowlist), applyChange = defaultApplyChange,
  sessionClient = (ctx) => require('./elicitation-clients').clientMayElicit(ctx || {}, allowlist),
  growValidators = (bytes) => require('./validator-pool').growFor(bytes),
  // the loaded top-level modules that declare settings, and the module.*
  // values applied now after a write (lib/settings-reread.js)
  moduleStates = () => require('./settings-reread').topModuleStates(),
  // whether the startup list is still loading (get says so)
  startingUp = () => require('./settings-reread').startingUp(),
  applyModuleSettings = (pkg) => require('./settings-reread').applyNow(pkg),
  // the loaded top-level modules, their closures and listed tools (the
  // enabled.* rows, and what goes with a module turned off)
  // the module manager the control channel acts on, passed in by the
  // caller (lib/mcp/gateway.js, the same lib/route-manager.js gives
  // lib/module-control.js): the one source of what is loaded and loading;
  // none is a clear error, never an empty list (#449's high review, round
  // 6, 8)
  mm = null,
  loadedTops = () => require('./modules-in-place').loadedTops(managerOf(mm)),
  // the top-level modules still loading (an off with the record unreadable
  // takes them as loaded: they run in a moment)
  loadingTops = () => require('./modules-in-place').loadingTops(managerOf(mm)),
  // (no session is told here of a module turned off: ch-local's unload of
  // it is the one source, lib/module-control.js with offNotice)
  }) {
  const dir = path.dirname(file);
  const historyFile = path.join(dir, 'history.jsonl');
  // whether the list says no form can be shown to anyone
  const noForms = require('./elicitation-clients').noClientTested(allowlist);

  // ctx.shared (a shared runtime's session, B2 Task 4): the two caps are
  // shown at the session's own effective values, and the history is the
  // session's view of it (readHistory).
  // the module rows (section 4.4): each loaded top-level module's declared
  // settings, a part's never (paged with the enabled rows: pagedRows)
  function moduleRows(c) {
    const rows = [];
    for (const m of moduleStates()) {
      const st = m.state;
      if (st == null || st.settings == null || m.part === true) continue;
      for (const setting of Object.keys(st.settings)) {
        const d = st.settings[setting];
        const row = {name: `module.${m.name}.${setting}`, module: m.name, version: m.version, type: d.type};
        if (st.values != null && Object.prototype.hasOwnProperty.call(st.values, setting)) row.value = st.values[setting];
        if (Object.prototype.hasOwnProperty.call(d, 'default') && d.default !== '') row.default = d.default;
        row.bounds = moduleBounds(d);
        // (what it takes here: with no client tested, no form can confirm one)
        const changes = moduleChanges(c, m.name, setting, d);
        row.changes = noForms && changes === 'needs your confirmation' ? 'at a terminal only' : changes;
        // the author's own words, labelled as the module's, cleaned as module
        // text is before it reaches a client (module-settings ownWords)
        const own = ownWords(d);
        if (Object.keys(own).length > 0) row.byTheModule = own;
        rows.push(row);
      }
    }
    return rows;
  }
  // the rows that grow with the modules installed and loaded, paged
  // together: the enabled rows first (one per installed top-level module),
  // then the module settings; MODULE_ROWS a call from `cursor` (#449's high
  // review, 9)
  // (at: the cursor as parseCursor read it)
  function pagedRows(values, c, at, tops = installedTops()) {
    const rows = enabledRows(values, tops).concat(moduleRows(c));
    const gen = generationOf(rows);
    const {offset: from, gen: was} = at;
    if (was != null && was !== gen) throw new CountinghouseError('SETTING_CURSOR_STALE');
    if (from > rows.length) throw new CountinghouseError('SETTING_CURSOR_INVALID');
    const page = rows.slice(from, from + MODULE_ROWS);
    return {page, next: (from + MODULE_ROWS < rows.length) ? cursorOf(from + MODULE_ROWS, gen) : null};
  }

  async function get(ctx = {}, args = {}) {
    const session = sharedSession(ctx);
    const cursor = args != null ? args.cursor : undefined;
    // a cursor that is not one of ours: refused before the file and the
    // ceiling are read (its bound, against the rows, is checked with them)
    const at = parseCursor(cursor);
    const {values} = readFile(file);
    const c = ceiling();
    const names = Object.keys(ALLOWLIST);
    // ch-local's record read once: the rows and the notice say the same of it, even while ch-local rewrites it
    const tops = installedTops();
    const modules = pagedRows(values, c, at, tops);
    // a page after the first: the paged rows alone (the runtime's settings
    // and the history came with the first)
    if (cursor != null) return Object.assign({settings: modules.page}, modules.next != null ? {nextCursor: modules.next} : {});
    const answer = {
      settings: names.map((name) => {
        const e = entryOf(name);
        // the operator's ceiling lowers a bound (a ceiling that cannot be
        // trusted is said by set, which refuses every loosening)
        const bounds = boundsOf(e);
        if (c != null && c.state === 'trusted' && Number.isInteger(c.ceiling[name]) && bounds.max != null) bounds.max = Math.max(bounds.min, Math.min(bounds.max, c.ceiling[name]));
        // a cap's value is what runs: in a shared runtime's session, what
        // that session runs with; otherwise what this runtime runs with
        // (ch-local may have started it under the ceiling, with nothing
        // stored), the stored one said beside it when it differs (a
        // terminal change awaiting the next start, a raise confirmed for
        // this start)
        // moduleSandbox's is the mode this runtime runs, from its start (off where it runs without workers), the stored one beside it
        // where it differs: a change waiting for the next start, a mode given at the start
        const ofSession = session != null && SESSION_CAPS.includes(name);
        const running = name === 'moduleSandbox' && typeof options.moduleSandbox === 'string';
        const value = ofSession ? require('./session-settings').effective(session, name) : isCap(name) ? effectiveOf(values, name) : running ? options.moduleSandbox : valueOf(values, name);
        const stored = (!ofSession && (isCap(name) || running) && isStored(values, name) && values[name] !== value) ? {stored: shown(values[name])} : {};
        return Object.assign({name: name, value: shown(value)}, stored, {default: shown(e.default), bounds: bounds, guarding: e.guarding, applies: e.applies});
      }).concat(modules.page),
      history: readHistory(historyFile, session)
    };
    if (modules.next != null) answer.nextCursor = modules.next;
    // ch-local's record there and unreadable: no on/off row can be listed, and that is said, never left silent (as the overview does)
    if (tops === null) answer.notice = `The list of installed packs could not be read, so their on/off settings are not listed: run \`${terminalCommand('status')}\` in your own terminal.`;
    // during startup a module still loading is not listed yet: said so
    if (startingUp() === true) answer.starting = 'still starting: some modules may not be listed yet';
    return answer;
  }

  // ---- enabled.<module> (#413 rev 3, sections 5.1 and 5.3; M5b): a
  // top-level module's on/off, every session of the user's. Off is made on
  // request; on needs the user's confirmation (a form for a tested client,
  // else the terminal). Written to the file under the lock; ch-local's
  // watcher loads or unloads the module (the tool asks it nothing).

  // the installed top-level modules (no part: a part has no switch); null
  // when ch-local's record is there and cannot be read
  function installedTops() {
    const all = installedModules(dir);
    if (all === UNREADABLE) return null;
    return all == null ? new Map() : new Map([...all].filter(([, m]) => m.top));
  }
  // get's rows: one per installed top-level module, its value (stored, else
  // the default, on), whether it is loaded, its version and its listed tools
  function enabledRows(values, tops = installedTops()) {
    const loaded = new Map(loadedTops().map((t) => [t.name, t]));
    return [...(tops || new Map())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([pkg, m]) => {
      const name = `enabled.${pkg}`;
      const t = loaded.get(pkg);
      return {name, module: pkg, value: shown(valueOf(values, name)), default: shown(true), bounds: {enum: ['on', 'off']}, guarding: true, applies: 'now',
        loaded: t != null, version: m.version, tools: t != null ? t.tools.slice().sort() : []};
    });
  }
  // the loaded top-level modules that call pkg (its callers, which go with it)
  const callersOf = (pkg, tops = loadedTops()) => callersIn(pkg, tops);
  // whether pkg is serving now, or is about to: loaded on its own, inside a
  // loaded caller's closure, or still loading
  // (loading: read with the loaded list, once a request: the medium review
  // of round 5, 10)
  const servingNow = (pkg, tops, loading = loadingTops()) => tops.some((t) => t.name === pkg) || callersIn(pkg, tops).length > 0 || loading.includes(pkg);
  // an on while ch-local's record cannot be read (#449's high review, 5)
  const RECORD_UNREADABLE = 'record unreadable';
  const recordUnreadable = (name, ch) => CountinghouseError.withFields('SETTING_RECORD_UNREADABLE', {name, command: enabledCommand(ch.pkg, ch.next !== false)});
  // -> {pkg, version, old, next, changes}, or throws: a name no installed
  // top-level module has (a part's included) is SETTING_UNKNOWN
  // (loadedNow: the loaded top-level modules, read once by the caller)
  function enabledChange(name, value, loadedNow = () => loadedTops(), loadingNow = () => loadingTops()) {
    const pkg = ENABLED.exec(name)[1];
    const next = onOff(value);
    const tops = installedTops();
    // ch-local's record unreadable (a write under way, a damaged file): an
    // off is made for a top-level module loaded or loading, where staying on
    // matters (a tightening is never refused, nor
    // counted); for a name not loaded it is the record's to say, retried, so
    // no name is written without end (#449's high review, round 4, 8). An on
    // is refused saying so (no version to confirm).
    if (tops == null) {
      if (next == null) throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name, value: String(value).slice(0, 80), bounds: boundsText(ENABLED_ENTRY)});
      const {values} = readFile(file);
      const old = valueOf(values, name);
      // (already off: no change, as when the record is read)
      // (one still loading counts: it runs in a moment, and an off is a
      // safety act: round 5's answer)
      // (taken: a top-level module loaded, or loading; a name found only
      // inside a caller's closure cannot be told from a part, so it is the
      // record's to say: round 6, 2)
      const loading = loadingNow();
      if (next === false && old !== false && !(loadedNow().some((t) => t.name === pkg) || loading.includes(pkg))) throw recordUnreadable(name, {pkg, next});
      return {pkg, version: null, old, next, changes: next === false ? 'on request' : RECORD_UNREADABLE, unreadable: true};
    }
    const mod = tops.get(pkg);
    if (mod == null) throw CountinghouseError.withFields('SETTING_UNKNOWN', {name: String(name).slice(0, 80)});
    if (next == null) throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name, value: String(value).slice(0, 80), bounds: boundsText(ENABLED_ENTRY)});
    const {values} = readFile(file);
    const old = valueOf(values, name);
    if (next === false || next === old) return {pkg, version: mod.version, old, next, changes: 'on request'};
    // turned on: the ceiling first (its modules list; a ceiling that cannot
    // be trusted, or turns conversation off, means no form)
    const c = ceiling();
    const refused = ceilingRefusal(c, name, next);
    if (refused != null) return {pkg, version: mod.version, old, next, changes: 'refused', refused};
    if (c != null && c.state === 'trusted' && c.ceiling.conversation === false) return {pkg, version: mod.version, old, next, changes: 'at a terminal only'};
    return {pkg, version: mod.version, old, next, changes: 'needs your confirmation'};
  }
  // a session's modules turned on, and the runtime's own when it has no
  // sessions, counted against MAX_SESSION_CHANGES (section 5.3: on a runtime
  // with one session too); past it an on is the terminal's. Checked and
  // counted under the lock (writeLocked's budget), so no two requests both
  // pass it. A module turned off is a tightening: never checked, never
  // counted, on any runtime (#449's high review, 6); each off follows an on,
  // so the lines a session writes stay bounded (with the record unreadable,
  // only a loaded module's off is made: enabledChange).
  const RUNTIME_OWN = '';
  function enabledBudget(name, ch, by, session) {
    const key = session != null ? session : RUNTIME_OWN;
    return {key, over: () => {
      if ((sessionChanges.get(key) || 0) < MAX_SESSION_CHANGES) return;
      refuseAsked(name, ch.next, by, `refused, terminal only (${MAX_SESSION_CHANGES} changes made in this session)`, session);
      throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name, value: cliValue(name, ch.next), command: enabledCommand(ch.pkg, ch.next)});
    }};
  }
  // written under the lock, the old value the file's there; -> {wrote, old}
  async function writeEnabled(name, ch, by, line, session) {
    const r = await writeLocked(name, ch.next, by, line, session, ch.next === true ? {budget: enabledBudget(name, ch, by, session)} : {counted: false});
    if (r.wrote) { try { LOG.I(`countinghouse_settings: ${name} turned ${ch.next === true ? 'on' : 'off'} by ${by}`); } catch (err) { /* not serving */ } }
    return r;
  }
  async function setEnabled(name, value, by, ctx = {}) {
    // (the loaded modules read once a request)
    let loadedOnce = null;
    let loadingOnce = null;
    const loadedNow = () => (loadedOnce != null ? loadedOnce : (loadedOnce = loadedTops()));
    const loadingNowOnce = () => (loadingOnce != null ? loadingOnce : (loadingOnce = loadingTops()));
    const ch = enabledChange(name, value, loadedNow, loadingNowOnce);
    const session = sharedSession(ctx);
    // the answer when the file holds the off already: stored off, but still
    // serving, is said, never a silent "no change" (round 5, 5; round 6, 3;
    // one place: the medium review of round 6, 4)
    const alreadyOff = (old) => Object.assign({name, old: shown(old), new: shown(false), applies: 'now'},
      servingNow(ch.pkg, loadedNow(), loadingNowOnce()) ? {said: `${ch.pkg} is already set off, but ch-local hasn't applied it yet; it's still serving.`} : {});
    if (ch.next === ch.old) return ch.next === false ? alreadyOff(ch.old) : {name, old: shown(ch.old), new: shown(ch.next), applies: 'now'};
    if (ch.next === false) {
      // what goes with it, read before it is written (its callers loaded now)
      const tops = loadedNow();
      const callers = callersOf(ch.pkg, tops);
      const r = await writeEnabled(name, ch, by, {}, session);
      // the file held it already (another request wrote it meanwhile)
      if (!r.wrote) return alreadyOff(r.old);
      // the asker only: every session is told by ch-local's unload, the one
      // source, with what went with it and the way back (#449's high
      // review, round 3, R: exact, no timers)
      // (one not loaded: no unload comes, so none is promised)
      // (the callers that go with it said too: #449's high review, round 4, 4;
      // one neither loaded nor called: nothing else changes)
      const p = callersPhrase(callers, 8);
      const goes = callers.length === 0 ? '' : `, and so ${p.does} ${p.names}, which ${p.verb} it`;
      // (the record unreadable: no "as soon as"; round 5, 8)
      const said = ch.unreadable === true ? `${ch.pkg} off is written; ch-local can't read its record right now and applies the off when it can${goes}.`
        // (loading counts: round 6, 4)
        : servingNow(ch.pkg, tops, loadingNowOnce()) ? `${ch.pkg} off is written; it turns off for every session as soon as ch-local applies it${goes}.`
        : `${ch.pkg} off is written; it is not loaded now, so nothing else changes.`;
      return Object.assign({name, old: shown(r.old), new: shown(ch.next), applies: 'now', said}, callers.length > 0 ? {alsoOff: callers} : {});
    }
    if (ch.changes === RECORD_UNREADABLE) {
      refuseAsked(name, ch.next, by, 'not confirmed (ch-local\'s record cannot be read)', session);
      throw recordUnreadable(name, ch);
    }
    if (ch.changes === 'refused') {
      refuseAsked(name, ch.next, by, 'refused by the ceiling', session);
      throw CountinghouseError.withFields(ch.refused.code, ch.refused.fields);
    }
    if (ch.changes === 'at a terminal only') {
      refuseAsked(name, ch.next, by, 'not confirmed (conversation off by the ceiling)', session);
      throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name, value: cliValue(name, ch.next), command: enabledCommand(ch.pkg, true)});
    }
    // (past the budget, no form: the terminal; counted only when written)
    enabledBudget(name, ch, by, session).over();
    return enabledForm(name, ch, by, ctx, session);
  }
  // One confirmation flow for the two kinds every session of the user's
  // shares, a module turned on (kind enabled) and a module setting (kind
  // module): the form staged for a client that may show it, else the
  // terminal; the retry verified as staged, and every check made again
  // after the client's conditions are asked. One trust boundary, kept once
  // (#449's high review, 8). A kind's spec:
  //   noun: what the kind's forms are of, in a history line's reason
  //   terminal(): the refusal naming the terminal command
  //   declinedThisStart(): the runtime's own refusal of a declined kind (else terminal)
  //   whyNot(ch): a reason no form may be shown for this change, or null
  //   formOf(ch): the form; staged(ch, session): kept beside the staged state
  //   nextOf(session): the value a retry names, as staged
  //   formAgain(check, session): the same form again (no answer yet)
  //   verified(session): the staged state used up
  //   shownOf(v): a value as the answer says it
  //   change(): the change resolved again; recheck(ch, next): an answer to
  //     end with, or null to go on (refusals thrown)
  //   beforeWrite(ch): checked just before the version (a budget)
  //   write(ch, v): the yes written -> the answer
  async function stageForm(name, ch, by, ctx, session, spec) {
    const sc = require('./settings-confirm');
    // a shared runtime's session: the user's window first (no room for a
    // form of this kind: the client is not asked), its own conditions, its
    // own store (its decline lock, its forms); otherwise the runtime's
    if (session != null && !sc.windowOpenFor(name)) {
      refuseAsked(name, ch.next, by, `not confirmed (too many declined or unanswered forms of ${spec.noun})`, session);
      throw spec.terminal();
    }
    const may = (session != null) ? await sessionMayElicit(ctx) : await mayElicit(ctx);
    // a session that ended while its client was asked: answered as its
    // calls are, no store made and nothing recorded for it
    if (session != null && !require('./sessions').live(session)) throw new CountinghouseError('MODULE_NOT_LISTED');
    const confirms = (session != null) ? sc.confirmations(session) : sc.confirmations();
    if (session != null) expiredLines(confirms, by, session);
    else {
      const swept = confirms.sweep();
      if (swept != null) appendLine({by, setting: swept.name, asked: swept.next, change: 'expired'});
    }
    if (confirms.declined(name)) {
      // (the lock is per kind: one declined form of a kind locks them all)
      refuseAsked(name, ch.next, by, `not confirmed (${spec.noun} ${session != null ? 'locked in this session' : 'declined this start'})`, session);
      throw session == null ? spec.declinedThisStart() : spec.terminal();
    }
    const client = may != null && may.ok === true && may.client != null && typeof(may.client.name) === 'string' && typeof(may.client.version) === 'string' ? may.client : null;
    const sid = ctx != null && typeof(ctx.session) === 'string' && ctx.session.length > 0 ? ctx.session : null;
    const why = may == null || may.ok !== true ? String((may && may.why) || 'client conditions unknown')
      : client == null ? 'client unknown' : sid == null ? 'session unknown'
        : spec.whyNot(ch) || (confirms.formsLeft() <= 0 ? 'no forms left' : null);
    const staged = why == null ? confirms.stage({name, old: ch.old, next: ch.next, version: ch.version, client, session: sid}) : null;
    if (staged == null) {
      refuseAsked(name, ch.next, by, `not confirmed (${why || 'no form may be shown now'})`, session);
      throw spec.terminal();
    }
    if (staged.replaced != null) appendLine(Object.assign({by, setting: staged.replaced.name, asked: staged.replaced.next, change: 'replaced'}, session != null ? {session} : {}));
    spec.staged(ch, session);
    return {inputRequired: {inputRequests: {approve: spec.formOf(ch)}, requestState: staged.requestState}};
  }
  // The retry with the user's answer: verified first, as the form staged it
  // (the state used up, a decline's lock set, whatever is checked again
  // after); a yes is written (the version confirmed in the history line),
  // unless the version changed meanwhile (SETTING_CHANGED_MEANWHILE);
  // anything else is a decline.
  async function confirmForm(name, {requestState, inputResponses} = {}, ctx = {}, spec) {
    const by = 'settings tool';
    const sc = require('./settings-confirm');
    const session = sharedSession(ctx);
    // a late answer for a session that has ended: answered as its calls
    // are, and no store made or told for it
    const gone = () => session != null && !require('./sessions').live(session);
    if (gone()) throw new CountinghouseError('MODULE_NOT_LISTED');
    try {
      const next = spec.nextOf(session);
      const confirms = (session != null) ? sc.confirmations(session) : sc.confirmations();
      const answer = inputResponses != null && typeof(inputResponses) === 'object' ? inputResponses.approve : undefined;
      // a form whose time ran out: a shared session's store has queued it,
      // said once (expiredLines); the runtime's own store is said here
      const expired = (code) => {
        if (session != null) expiredLines(confirms, by, session);
        else if (code === 'SETTING_CONFIRMATION_EXPIRED') appendLine({by, setting: name, asked: next, change: 'expired'});
      };
      // no answer: the same form again, as staged
      if (answer == null || typeof(answer) !== 'object') {
        const check = confirms.check(requestState, {name, next, session: ctx.session});
        expired(check.ok ? null : check.code);
        if (!check.ok) throw new CountinghouseError(check.code);
        return {inputRequired: {inputRequests: {approve: spec.formAgain(check, session)}, requestState: check.requestState}};
      }
      const v = confirms.verify(requestState, {name, next, session: ctx.session});
      expired(v.ok ? null : v.code);
      if (!v.ok) throw new CountinghouseError(v.code);
      spec.verified(session);
      const accepted = answer.action === 'accept' && answer.content != null && typeof(answer.content) === 'object' && answer.content.approve === true;
      if (!accepted) {
        confirms.decline(name);
        appendLine(Object.assign({by, setting: name, asked: next, change: 'declined'}, session != null ? {session} : {}));
        return {name, old: spec.shownOf(v.staged.old), new: spec.shownOf(v.staged.old), applies: 'declined'};
      }
      // Checked again now, each refusal recorded, after the client's
      // conditions are asked (so nothing that changes while they are is
      // missed): the session still open, the change (the record, the
      // declaration, the ceiling), the user's window and the decline lock
      // (per kind), the client the form was staged for, and the version the
      // form named.
      const may = (session != null) ? await sessionMayElicit(ctx) : await mayElicit(ctx);
      // a session that ended while its client was asked: answered as its
      // calls are, nothing recorded, counted or written for it
      if (gone()) throw new CountinghouseError('MODULE_NOT_LISTED');
      let ch = null;
      try {
        ch = spec.change();
      } catch (err) {
        refuseAsked(name, next, by, `not confirmed (${err != null && typeof(err.code) === 'string' ? err.code : 'refused'} now)`, session);
        throw err;
      }
      const ended = spec.recheck(ch, session);
      if (ended != null) return ended;
      if (session != null && sc.userWindow().locked(sc.kindOf(name))) {
        refuseAsked(name, ch.next, by, `not confirmed (too many declined or unanswered forms of ${spec.noun})`, session);
        throw spec.terminal();
      }
      if (confirms.declined(name)) {
        refuseAsked(name, ch.next, by, `not confirmed (${spec.noun} locked meanwhile)`, session);
        throw spec.terminal();
      }
      const sameClient = may != null && may.ok === true && may.client != null && v.staged.client != null &&
        may.client.name === v.staged.client.name && may.client.version === v.staged.client.version;
      if (!sameClient) {
        refuseAsked(name, ch.next, by, `not confirmed (${may != null && may.ok === true ? 'another client' : String((may && may.why) || 'client conditions unknown')})`, session);
        throw spec.terminal();
      }
      spec.beforeWrite(ch, session);
      if (v.staged.version !== ch.version) throw CountinghouseError.withFields('SETTING_CHANGED_MEANWHILE', {name});
      return spec.write(ch, v, session);
    } finally {
      // a shared session's state as it now stands, told once (none for one
      // that ended meanwhile)
      if (session != null && !gone()) sc.announceFor(session);
    }
  }

  // the kind enabled: a module turned on, its form the runtime's sentence
  // (FORM_TEXT enabled) naming the version, written with it confirmed
  function enabledSpec(name, value) {
    const pkg = ENABLED.exec(name)[1];
    const by = 'settings tool';
    const terminal = () => CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name, value: 'on', command: enabledCommand(pkg, true)});
    return {
      noun: 'modules turned on',
      terminal,
      declinedThisStart: () => CountinghouseError.withFields('SETTING_DECLINED_THIS_START', {name, command: enabledCommand(pkg, true)}),
      whyNot: (ch) => (ch.version == null ? 'the module\'s version is not a plain one' : null),
      formOf: (ch) => formFor(name, ch.old, ch.next, ch.version),
      staged: () => {},
      nextOf: () => onOff(value),
      formAgain: (check) => formFor(name, check.staged.old, check.staged.next, check.staged.version),
      verified: () => {},
      shownOf: shown,
      change: () => enabledChange(name, value),
      recheck: (ch, session) => {
        if (ch.next === ch.old) return {name, old: shown(ch.old), new: shown(ch.next), applies: 'now'};
        if (ch.changes === 'refused') {
          refuseAsked(name, ch.next, by, 'not confirmed (refused by the ceiling now)', session);
          throw CountinghouseError.withFields('SETTING_CEILING_CHANGED_MEANWHILE', {name});
        }
        if (ch.changes === RECORD_UNREADABLE) {
          refuseAsked(name, ch.next, by, 'not confirmed (ch-local\'s record cannot be read now)', session);
          throw recordUnreadable(name, ch);
        }
        if (ch.changes !== 'needs your confirmation') {
          refuseAsked(name, ch.next, by, `not confirmed (${ch.changes} now)`, session);
          throw terminal();
        }
        return null;
      },
      // (the budget: checked and counted under the lock, by writeEnabled)
      beforeWrite: () => {},
      write: async(ch, v, session) => {
        const r = await writeEnabled(name, ch, by, {confirmed: `${ch.version} (elicitation, ${v.staged.client.name} ${v.staged.client.version})`}, session);
        return {name, old: shown(r.old), new: shown(ch.next), applies: 'now'};
      }
    };
  }
  const enabledForm = (name, ch, by, ctx, session) => stageForm(name, ch, by, ctx, session, enabledSpec(name, ch.next));
  const confirmEnabled = (name, value, answer = {}, ctx = {}) => confirmForm(name, answer, ctx, enabledSpec(name, value));

  // ---- module.<package>.<setting> (section 4.4): every session of the user.
  // The value is checked against the running declaration and the net it was
  // granted; the ceiling binds; a change on request is written under the
  // lock (history line first), then applied; one that needs the user's
  // confirmation is asked in the runtime's own form (kind `module`), or ends
  // at the terminal (no tested client, no form left). A hint names the
  // setting and never carries a value.

  // -> {pkg, setting, st, decl, version, next, changes}, or throws
  // the loaded top-level module that declares the setting a name names, or
  // null: -> {pkg, setting, target}
  function targetOf(name) {
    const m = MODULE_SETTING.exec(name);
    const target = moduleStates().find((x) => x.part !== true && x.name === m[1] && x.state != null && x.state.settings != null &&
      Object.prototype.hasOwnProperty.call(x.state.settings, m[2]));
    return target == null ? null : {pkg: m[1], setting: m[2], target};
  }
  // a value as its declaration reads it, checked: -> checkValue's answer,
  // with the value it was checked as
  function checkedOf(t, value) {
    const st = t.target.state;
    return checkedWith(st.settings[t.setting], st.made != null ? st.made.net : null, value);
  }

  // (t: the target already resolved, when nothing was awaited since)
  function moduleChange(name, value, t = targetOf(name)) {
    if (t == null) throw CountinghouseError.withFields('SETTING_UNKNOWN', {name: String(name).slice(0, 80)});
    const {pkg, setting, target} = t;
    const st = target.state;
    const decl = st.settings[setting];
    const checked = checkedOf(t, value);
    if (!checked.ok) throw CountinghouseError.withFields('SETTING_INVALID', {name, reason: checked.reason});
    // the ceiling is read before the lock is taken (on Windows it may spawn PowerShell)
    const c = ceiling();
    if (c != null && c.state !== 'none' && c.state !== 'trusted') {
      throw CountinghouseError.withFields('SETTING_CEILING_UNTRUSTED', {file: String(c.file), problem: String(c.problem).slice(0, 200)});
    }
    const changes = moduleChanges(c, pkg, setting, decl);
    if (changes === 'fixed by the operator') throw CountinghouseError.withFields('SETTING_FIXED_BY_CEILING', {name});
    const old = (st.values != null && Object.prototype.hasOwnProperty.call(st.values, setting)) ? st.values[setting] : null;
    return {pkg, setting, st, decl, version: target.version, old, next: checked.value, changes};
  }

  // a session's changes recorded: past MAX_SESSION_CHANGES its changes are
  // the terminal's (asked and refused, recorded once and counted)
  function overBudget(name, next, by, ch, session) {
    if (session == null || (sessionChanges.get(session) || 0) < MAX_SESSION_CHANGES) return;
    refuseAsked(name, next, by, `refused, terminal only (${MAX_SESSION_CHANGES} changes made in this session)`, session);
    throw CountinghouseError.withFields('SETTING_MODULE_NEEDS_CONFIRMATION', {name, command: moduleCommandFor(ch.pkg, ch.setting)});
  }

  // the value written under the lock (the new file aside, the history line,
  // the rename; unknown names kept), then applied; -> whether it was written
  // The one write of a setting a session makes for every session (a module
  // setting, a module's on/off), under the lock: the new file aside, the
  // history line first (a session's names it, with the EVERY_SESSION marker
  // in its own field, so every session reads it: readHistory's seenOf;
  // `change` absent, as for any real change, which ch-local's outside-edits
  // replays), then the rename; unknown names kept. old: the value the line
  // names (a module setting's, as the module holds it), else the file's own
  // under the lock. budget: {key, over()} checked and counted under the lock
  // (no two requests both pass it); else a session's change counts toward
  // its own. -> {wrote, old}
  // (counted: false for a change that never counts against the budget, a
  // module turned off)
  async function writeLocked(name, next, by, line, session, {old = undefined, budget = null, counted = true} = {}) {
    return withLock(dir, lockWaitMs, async () => {
      const {raw, values} = readFile(file);
      const was = old !== undefined ? old : valueOf(values, name);
      if (Object.prototype.hasOwnProperty.call(raw, name) && raw[name] === next) return {wrote: false, old: was};
      if (budget != null) budget.over();
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify({version: 1, values: Object.assign({}, raw, {[name]: next})}, null, 2)}\n`);
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        throw fileInvalid(`it cannot be written (${err.code || 'error'})`);
      }
      writeCounts(historyFile);
      try {
        appendHistoryLine(historyFile, Object.assign({by, setting: name, old: was, new: next}, line, everySession(session)));
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        throw new CountinghouseError('SETTING_NOT_RECORDED');
      }
      try {
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        // every session's too, as the change it undoes (exactly 'not made':
        // ch-local's outside-edits undoes the change before it by that label)
        try { appendHistoryLine(historyFile, Object.assign({by, setting: name, change: 'not made', problem: err.code || 'error'}, everySession(session))); } catch (e) { /* the error below says it */ }
        throw fileInvalid(`it cannot be replaced (${err.code || 'error'})`);
      }
      const key = budget != null ? budget.key : session;
      if (counted && key != null) sessionChanges.set(key, (sessionChanges.get(key) || 0) + 1);
      return {wrote: true, old: was};
    });
  }

  // the value written under the lock (writeLocked), then applied; -> whether
  // it was written
  async function writeModule(name, ch, by, line = {}, session = null) {
    const {wrote} = await writeLocked(name, ch.next, by, line, session, {old: ch.old});
    if (wrote) { try { LOG.I(`countinghouse_settings: ${name} changed by ${by}`); } catch (err) { /* not serving */ } }
    // a value the file already held, not running (it was not applied):
    // nothing written, but applied all the same
    if (!wrote && ch.old === ch.next) return 'unchanged';
    // then applied: every module's module.* values again (every session is
    // told what changed: lib/settings-reread.js).
    // The change is written and recorded: one that cannot be applied now is
    // said so, never as nothing changed (the next reread or load applies it).
    let reply = null;
    let timer = null;
    try {
      // never longer than APPLY_WAIT_MS behind the control channel's earlier
      // operations (a slow load): past it, written, applied when its turn
      // comes (the queued reread still runs) or at the next reread or load
      reply = await Promise.race([applyModuleSettings(ch.pkg),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`not applied within ${applyWaitMs} ms`)), applyWaitMs); })]);
    } catch (err) {
      try { LOG.I(`countinghouse_settings: ${name} was written, and could not be applied now (${err && err.message ? String(err.message).slice(0, 200) : 'error'})`); } catch (e) { /* not serving */ }
      return 'written';
    } finally {
      clearTimeout(timer);
    }
    // What runs now for this setting decides the answer, never this
    // reread's count: another reread (ch-local's, another session's, the
    // ceiling's watch, a registration) may have applied it first.
    const t = targetOf(name);
    const values = (t != null && t.target.state != null) ? t.target.state.values : null;
    // (a string cleared to '' runs as no value: the key is not there)
    const has = values != null && Object.prototype.hasOwnProperty.call(values, ch.setting);
    if (values != null && ((has && values[ch.setting] === ch.next) || (!has && ch.next === ''))) return 'applied';
    // Not running. A refusal in this module at this apply says why (a module
    // with any refused value keeps ALL of its old values): this setting's
    // own, else the setting that held them all. Only this module's: the
    // reread may have been a whole one (the file put right after a problem),
    // and a refusal's module is read by the one grammar (a package name may
    // hold dots).
    const mine = (r) => r != null && typeof(r.name) === 'string' &&
      (r.name === `module.${ch.pkg}` || (MODULE_SETTING.exec(r.name) || [])[1] === ch.pkg);
    const refused = (reply != null && Array.isArray(reply.refused)) ? reply.refused.filter(mine) : [];
    const own = refused.find((r) => r.name === name);
    if (own != null) return {refused: {setting: name, code: own.code}};
    if (refused.length > 0) return {refused: {setting: refused[0].name, code: refused[0].code}, kept: true};
    // nothing applied it (the module unloaded or reloading meanwhile):
    // written, applied at its next load or reread, never 'now'
    return 'written';
  }

  // what set and confirm answer: applied now, or written and applied at
  // the next reread or load (it could not be applied now)
  function moduleDone(name, ch, how) {
    if (how != null && typeof(how) === 'object' && how.refused != null) {
      // another setting's refusal: named, and the module kept all its values
      return Object.assign({name, old: ch.old, new: ch.next, applies: 'not applied', refused: how.refused},
        how.kept === true ? {kept: 'the module kept all of its values'} : {}, {scope: 'every session of this user'});
    }
    return {name, old: ch.old, new: ch.next, applies: how === 'written' ? 'next re-read' : 'now', scope: 'every session of this user'};
  }

  async function setModule(name, value, by, ctx = {}) {
    const ch = moduleChange(name, value);
    const session = (ctx != null && ctx.shared === true && typeof(ctx.session) === 'string') ? ctx.session : null;
    if (ch.changes === 'on request') {
      overBudget(name, ch.next, by, ch, session);
      return moduleDone(name, ch, await writeModule(name, ch, by, {}, session));
    }
    if (ch.changes === 'needs your confirmation') {
      overBudget(name, ch.next, by, ch, session);
      return moduleForm(name, ch, by, ctx, session);
    }
    throw CountinghouseError.withFields('SETTING_MODULE_NEEDS_CONFIRMATION', {name, command: moduleCommandFor(ch.pkg, ch.setting)});
  }

  // the kind module: a module setting that needs the user's confirmation,
  // its form the runtime's sentence (moduleFormFor), the declaration it was
  // checked against kept beside the staged state, the session's budget
  // checked before the version
  function moduleSpec(name, value, t0 = undefined) {
    const m = MODULE_SETTING.exec(name);
    const by = 'settings tool';
    const terminal = () => CountinghouseError.withFields('SETTING_MODULE_NEEDS_CONFIRMATION', {name, command: moduleCommandFor(m[1], m[2])});
    // (resolved once for a retry: the value it names, as staged)
    const first = () => (t0 === undefined ? (t0 = targetOf(name)) : t0);
    return {
      noun: 'module settings',
      terminal,
      declinedThisStart: terminal,
      whyNot: () => null,
      formOf: (ch) => moduleFormFor(ch, name),
      staged: (ch, session) => stagedModuleForms.set(storeKeyOf(session), {name, decl: ch.decl, net: ch.st.made != null ? ch.st.made.net : null}),
      nextOf: (session) => moduleNextOf(name, value, first(), session),
      // the form as staged (the declaration, version and values its state
      // confirms), never rebuilt from a module reloaded meanwhile
      formAgain: (check, session) => {
        const sd = stagedModuleForms.get(storeKeyOf(session));
        const ch = (sd != null && sd.name === name)
          ? {pkg: m[1], setting: m[2], decl: sd.decl, version: check.staged.version, old: check.staged.old, next: check.staged.next}
          : moduleChange(name, value, first());
        return moduleFormFor(ch, name);
      },
      verified: (session) => stagedModuleForms.delete(storeKeyOf(session)),
      shownOf: (x) => x,
      // resolved again (not t0): the module may have changed while the
      // conditions were asked
      change: () => moduleChange(name, value),
      recheck: (ch, session) => {
        if (ch.changes !== 'needs your confirmation' && ch.changes !== 'on request') {
          refuseAsked(name, ch.next, by, `not confirmed (${ch.changes} now)`, session);
          throw terminal();
        }
        return null;
      },
      beforeWrite: (ch, session) => overBudget(name, ch.next, by, ch, session),
      write: async(ch, v, session) => moduleDone(name, ch, await writeModule(name, ch, by, {confirmed: ch.version}, session))
    };
  }
  // The form for a module setting that needs the user's confirmation (one
  // flow with a module turned on: stageForm)
  const moduleForm = (name, ch, by, ctx, session) => stageForm(name, ch, by, ctx, session, moduleSpec(name, ch.next));

  // the value a retry names, as the form staged it (checked and normalised
  // as moduleChange does, without its refusals): what the form's state is
  // verified against before anything is checked again (a declaration gone
  // meanwhile: the value as sent, which the state then does not match)
  function moduleNextOf(name, value, t, session) {
    const staged = stagedModuleForms.get(storeKeyOf(session));
    const checked = (staged != null && staged.name === name) ? checkedWith(staged.decl, staged.net, value)
      : t != null ? checkedOf(t, value) : null;
    if (checked == null) return value;
    return checked.ok ? checked.value : checked.as;
  }

  // The retry with the user's answer to a module setting's form (confirmForm)
  const confirmModule = (name, value, answer = {}, ctx = {}) => confirmForm(name, answer, ctx, moduleSpec(name, value));

  async function set(name, value, by = 'settings tool', ctx = {}) {
    // a module setting: every session of the user, whatever the scope
    if (typeof(name) === 'string' && MODULE_SETTING.test(name)) return setModule(name, value, by, ctx);
    // a module's on/off: every session's too (section 5.3)
    if (typeof(name) === 'string' && ENABLED.test(name)) return setEnabled(name, value, by, ctx);
    const e = entryOf(name);
    if (e == null) throw CountinghouseError.withFields('SETTING_UNKNOWN', {name: String(name).slice(0, 80)});
    const shownValue = String(value).slice(0, 80);
    const next = e.parse(value);
    if (next == null || Number.isNaN(next) || !validStored(e, next)) {
      throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: shownValue, bounds: boundsText(e)});
    }
    const scope = scopeOf(ctx);
    // a shared runtime's session: its own override, a change it asks for
    // all sessions, or the terminal's
    // (every line it writes names the session: inSessionPath)
    if (ctx != null && ctx.shared === true) return inSessionPath(sharedSession(ctx), () => (scope != null ? setForAll(name, next, by, ctx) : setForSession(name, next, by, ctx)));
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
      // moduleSandbox asked for other than the mode this runtime runs, nothing stored: written for the next start, said from what runs,
      // as get shows it (never a "done" from the file's default while get's row shows another)
      const running = name === 'moduleSandbox' && typeof options.moduleSandbox === 'string' && options.moduleSandbox !== next && !isStored(values, name) ? options.moduleSandbox : null;
      // a value equal to the file's and to this runtime's changes nothing and
      // records nothing, so a repeated no-op cannot push real entries out of
      // get's view. (One the runtime only started with, under the default,
      // is not in the file: asked for, it is stored below when it may be
      // (storable), so it holds when the ceiling or the flag that gave it is
      // gone.)
      if (next === old && next === effective && kept && running == null) return {done: {name: name, old: shown(old), new: shown(next), applies: e.applies}};
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
      // with nothing stored, a cap this runtime now runs UNDER the value
      // asked for (lowered for this start, or brought down by ch-local)
      const aboveWhatRuns = isCap(name) && !isStored(values, name) && next > effective;
      // the file's value already, this runtime still on another (a terminal
      // change awaiting the next start): nothing to write. Not the start
      // value asked for once the runtime runs under it: that is a raise of
      // what runs (below), as any value between is.
      if (next === old && kept && !aboveWhatRuns && running == null) return {done: {name: name, old: shown(old), new: shown(next), applies: 'next start'}};
      // What may be put in the file with no form, for a cap (the reviewer's
      // ruling on #287). Never more than the file yields now (its stored
      // value, else the default): the baseline with nothing stored is what
      // the runtime started with, and a runtime started ABOVE the default by
      // a flag would otherwise have conversation raise the file toward its
      // start value, unasked. And nothing above the ceiling, unless it
      // lowers what the file yields: that tightens every later start
      // (which the ceiling bounds anyway), so it is kept.
      const yields = valueOf(values, name);
      const storable = !isCap(name) || (next <= yields && (aboveCeiling(theCeiling, name, next) == null || next < yields));
      // above what runs (lowered, then asked back up, at most to the start
      // value) and no lowering of what the file yields: a raise of what
      // runs, as any other. (One that lowers the file's yield is written
      // for the next start, below, and raises nothing now.)
      const raisesWhatRuns = aboveWhatRuns && next >= yields;
      // a loosening is what is looser than the baseline (a tightening of the
      // file is written, whatever this runtime runs with), or raises what runs
      if (e.guarding && (!e.tighter(old, next) || raisesWhatRuns)) {
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
      // A value that may not be stored, at or under what runs: what runs
      // already changes nothing, and nothing is kept; a tightening of it is
      // never refused, and applies to this start only, written nowhere and
      // recorded as that (never as a stored change).
      if (!storable) {
        if (next === effective) return {done: {name: name, old: shown(effective), new: shown(next), applies: 'this start'}};
        writeCounts(historyFile);
        appendLine({by: by, setting: name, old: effective, new: next, change: 'this start'}, true);
        return {thisStart: {old: effective}};
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
      // what the change is said from: what the file yields (its stored
      // value, else the default); for a cap with nothing stored that this
      // write brings down, what runs (its start value, unless this start
      // changed it since). A write above what runs changes nothing running:
      // said from what runs it would read as a raise.
      const from = running != null ? running : (begun != null && next <= effective) ? effective : yields;
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify({version: 1, values: Object.assign({}, raw, {[name]: next})}, null, 2)}\n`);
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        throw fileInvalid(`it cannot be written (${err.code || 'error'})`);
      }
      // the counts of requests not confirmed go before this change, in order
      writeCounts(historyFile);
      const line = {at: new Date().toISOString(), by: by, setting: name, old: from, new: next};
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
      try { LOG.I(`countinghouse_settings: ${name} changed from ${JSON.stringify(shown(from))} to ${JSON.stringify(shown(next))} by ${by}`); } catch (err) { /* not serving */ }
      // a tightened cap applies on the main thread at once (it checks every
      // result), so this runtime's effective value is never staler than the
      // file it just wrote; ch-local's control set repeats it for the workers
      if (isCap(name) && Number.isInteger(options[name]) && next < options[name]) options[name] = next;
      // a cap written above what runs (a tightening of a stored value this
      // runtime does not run with yet) changes nothing now
      const applies = (isCap(name) && Number.isInteger(effective) && next > effective) ? 'next start' : e.applies;
      return {done: {name: name, old: shown(from), new: shown(next), applies: applies}};
    });
    if (decided.done != null) return decided.done;
    if (decided.thisStart != null) return applyThisStart(name, decided.thisStart.old, next, by);
    return formOrRefusal(name, next, decided.ask.old, by, ctx);
  }

  // A change asked for in a shared runtime's session (B2 Tasks 4 and 5).
  // Only the two caps. A value no looser than the session's own effective
  // one becomes the session's override at once (lib/session-settings.js),
  // for its calls only, for its life; a looser one needs the session's
  // user to confirm it, in that session's own form (formForSession), and
  // then becomes its override too. Nothing is written to settings.json and
  // the options every session shares stay as they are; every history line
  // names the session. Every other setting is the terminal's: a pack's
  // on/off is never a session's own (M5a, #413 rev 3 section 5.4).
  async function setForSession(name, next, by, ctx) {
    const session = sharedSession(ctx);
    const terminalOnly = () => CountinghouseError.withFields('SETTING_TERMINAL_ONLY_SHARED', {name: name, command: commandFor(name, next)});
    if (session == null || !SESSION_CAPS.includes(name)) throw terminalOnly();
    const sessionSettings = require('./session-settings');
    // the ceiling is read afresh before the lock (as set reads it), so what
    // counts as a loosening never depends on how stale the cache was
    const theCeiling = ceiling();
    const decided = await withLock(dir, lockWaitMs, async () => {
      // a session that ended while this waited (or was never one): answered
      // as its calls are (lib/mcp/gateway.js), and nothing recorded. From
      // here to the override there's no wait, so it cannot end in between.
      if (require('./sessions').get(session) == null) throw new CountinghouseError('MODULE_NOT_LISTED');
      const old = sessionSettings.effective(session, name);
      if (next === old) return {done: {name: name, old: old, new: next, applies: 'this session'}};
      const overBudget = (sessionChanges.get(session) || 0) >= MAX_SESSION_CHANGES;
      // This session's own lowering undone, in conversation and with no
      // form (the dry run, walk step 15a: a session that had lowered
      // requestTimeout to 10 s could not raise it back, and its own
      // composite tool timed out). Up to, never above, what a session with no
      // value of its own runs at: the value for all sessions under the
      // ceiling. Only this session's own value changes; a kind the user
      // locked in it stays locked (a latch, its client's own, does not hold
      // it, nor a lock restored where no form can be shown); the undo is said to it and written, as its lowering was.
      const ownNow = sessionSettings.overridesOf(session).find((o) => o.name === name);
      const allNow = sessionSettings.underCeiling()[name];
      // (a value marked as a confirmed loosening stays on the form's route,
      // the stricter answer: the two routes differ only within this bound)
      if (ownNow != null && ownNow.loosening !== true && next > old && next <= allNow) {
        // the ceiling read before the lock's wait, read again under it: one
        // the operator changed meanwhile applies nothing (#537's high, L1)
        const again = ceiling({cacheOnly: true});
        if (again === undefined || JSON.stringify(again) !== JSON.stringify(theCeiling)) {
          appendLine({by: by, setting: name, asked: next, change: 'not applied (ceiling changed meanwhile)', session: session});
          throw CountinghouseError.withFields('SETTING_CEILING_CHANGED_MEANWHILE', {name: name});
        }
        const confirmLib = require('./settings-confirm');
        const confirms = confirmLib.confirmations(session);
        expiredLines(confirms, by, session);
        // the operator's ceiling first, as for a loosening (the medium on the
        // undo, 1): one that forbids the setting, or is not trusted, answers
        // as it does there; one that turns conversation off, or a lock that
        // is or may be the user's, leaves no way back here -- and a terminal change
        // never moves a session's own value, so the refusal names none: the
        // session's end clears it (the medium on the undo, 2)
        const above = ceilingRefusal(theCeiling, name, next);
        if (above != null) {
          refuseAsked(name, next, by, 'refused by the ceiling', session);
          throw CountinghouseError.withFields(above.code, above.fields);
        }
        const held = (why) => CountinghouseError.withFields('SETTING_SESSION_OWN_VALUE_HELD', {name: name, current: cliValue(name, old), value: cliValue(name, allNow), why: why});
        // (what holds the way back: wayBackHeld, which the no-form answers' own-lower sentence reads too)
        const hold = wayBackHeld(confirms, name, theCeiling);
        if (hold === 'ceiling') {
          refuseAsked(name, next, by, 'not confirmed (conversation off by the ceiling)', session);
          throw held('the operator\'s ceiling turns changes in conversation off');
        }
        // a lock that is the user's, or may be: never the latch's alone, which
        // only says a form could be answered for the user, and the undo
        // shows none (walk finding 6)
        // A restored one may be a decline's only where a form can be shown:
        // with no tested client it doesn't hold (R-undo-after-restart).
        // Accepted: a decline made under a version that had a tested client,
        // then that version taken back, comes back as restored and doesn't
        // hold this; nothing goes above the value for all sessions by it.
        if (hold === 'user' || hold === 'restored') {
          refuseAsked(name, next, by, 'not confirmed (locked in this session)', session);
          throw held(hold === 'restored' ? 'it may have been locked before the runtime restarted' : 'a change to it was declined or left unanswered in this session');
        }
        // the user's window, across sessions: three declines, or a start
        // with no restore table (fail closed). A session replayed after that
        // start has lost its own lock, and this is what remains of it
        // (#537's high, M1)
        if (hold === 'window') {
          refuseAsked(name, next, by, 'not confirmed (too many declined or unanswered forms)', session);
          throw held('changes to it in conversation are paused across your sessions, for up to 30 minutes');
        }
        if (overBudget) {
          refuseAsked(name, next, by, PAST_BUDGET_UNDO, session);
        } else {
          writeCounts(historyFile);
          appendLine({by: by, setting: name, old: old, new: next, change: 'this session: its own lowering undone', session: session}, true);
        }
        // back to the value for all sessions: its own value goes; part of the
        // way: its own value, lower than the value for all sessions still. A
        // set that fails puts its own value back and is said as not made
        // (the medium on the undo, 3)
        sessionSettings.clear(session, name);
        if (next < allNow) {
          try {
            sessionSettings.set(session, name, next);
          } catch (err) {
            try { sessionSettings.set(session, name, ownNow.value); } catch (_) { /* its own value: a tightening, taken */ }
            appendLine({by: by, setting: name, change: 'not made', problem: String(err.code || 'error').slice(0, 40), session: session});
            throw err;
          }
        }
        sessionChanges.set(session, (sessionChanges.get(session) || 0) + 1);
        if (name === 'requestTimeout') require('./session').rearmSession(session);
        const text = next === allNow
          ? `${name} back to ${cliValue(name, next)} for this session: the value for all sessions (it had been lowered to ${cliValue(name, old)} in this session)`
          : `${name} raised to ${cliValue(name, next)} for this session, toward the value for all sessions (${cliValue(name, allNow)}); it had been lowered to ${cliValue(name, old)} in this session`;
        require('./notices').add(null, text, {session: session, sessionOnly: true});
        try { LOG.I(`countinghouse_settings: ${text}`); } catch (err) { /* not serving */ }
        return {done: {name: name, old: old, new: sessionSettings.effective(session, name), applies: 'this session'}};
      }
      if (sessionSettings.isLoosening(session, name, next)) {
        if (overBudget) {
          refuseAsked(name, next, by, `refused, terminal only (${MAX_SESSION_CHANGES} changes made in this session)`, session);
          throw withOwnLower(terminalOnly(), session, name, next, theCeiling);
        }
        // no form: refused by the ceiling, conversation off by it, locked in
        // this session (a decline, two forms unanswered, or the latch), or
        // no forms left in it
        const above = ceilingRefusal(theCeiling, name, next);
        const confirms = require('./settings-confirm').confirmations(session);
        expiredLines(confirms, by, session);
        const noForm = above != null ? 'refused by the ceiling'
          : (theCeiling != null && theCeiling.state === 'trusted' && theCeiling.ceiling.conversation === false) ? 'not confirmed (conversation off by the ceiling)'
            : confirms.declined(name) ? 'not confirmed (locked in this session)'
              : confirms.formsLeft() <= 0 ? 'not confirmed (no forms left in this session)' : null;
        if (noForm != null) {
          refuseAsked(name, next, by, noForm, session);
          if (above != null) throw CountinghouseError.withFields(above.code, above.fields);
          if (confirms.declined(name)) throw withOwnLower(lockedError(confirms, name, next), session, name, next, theCeiling);
          throw withOwnLower(CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)}), session, name, next, theCeiling);
        }
        // the form is decided outside the lock (the session's client is asked)
        return {ask: {old: old}};
      }
      // recorded first: a change the history cannot hold is not made (past
      // the budget, as one line of its kind and a count)
      if (overBudget) {
        refuseAsked(name, next, by, PAST_BUDGET, session);
      } else {
        writeCounts(historyFile);
        appendLine({by: by, setting: name, old: old, new: next, change: 'this session', session: session}, true);
      }
      let applied;
      try {
        applied = sessionSettings.set(session, name, next);
      } catch (err) {
        // the history never shows a change not made (as a file that could
        // not be replaced is said)
        appendLine({by: by, setting: name, change: 'not made', problem: String(err.code || 'error').slice(0, 40), session: session});
        throw err;
      }
      sessionChanges.set(session, (sessionChanges.get(session) || 0) + 1);
      // its calls under way: the timer is re-armed from each call's start
      // (the output cap is read at the reply)
      if (name === 'requestTimeout') require('./session').rearmSession(session);
      try { LOG.I(`countinghouse_settings: ${name} changed from ${JSON.stringify(old)} to ${JSON.stringify(applied.new)} by ${by}, for one session`); } catch (err) { /* not serving */ }
      // (what is in force now, the store's answer, never only what was asked: A4)
      return {done: {name: name, old: old, new: applied.new, applies: 'this session'}};
    });
    if (decided.done != null) return decided.done;
    return formForSession(name, next, decided.ask.old, by, ctx);
  }

  // an all-sessions tightening's line; past the asking session's budget, one
  // line of its kind and a count (A5). Throws when it can't be recorded: a
  // change the history cannot hold is not made.
  function recordAllSessions(line, overBudget) {
    // (named for the asking session, as a line in its path must be: its
    // "all sessions" change is every session's to read, readHistory's forAll)
    if (overBudget) return refuseAsked(line.setting, line.new, line.by, PAST_BUDGET_ALL, line.session, 'all-sessions');
    writeCounts(historyFile);
    appendLine(line, true);
  }

  // The forms a session's timer expired while nobody asked: said in the
  // history, as the session's.
  function expiredLines(confirms, by, session) {
    confirms.sweep();
    for (const gone of confirms.takeExpired()) appendLine(Object.assign({by: by, setting: gone.name, asked: gone.next, change: gone.ended, session: session}, scoped(gone.scope)));
  }

  // Whether this session may be shown a form: its request's client is a
  // tested one that declares the form (sessionClient), and its client
  // answers, now, status ok and conditions yes (lib/sessions.js
  // askConditions; null, failed or a plain no is no). The session's own
  // answer: nothing process-wide is asked in a shared runtime (finding 1).
  async function sessionMayElicit(ctx) {
    const c = sessionClient(ctx);
    if (c == null || c.ok !== true) return c || {ok: false, why: 'client unknown'};
    const answer = await require('./sessions').askConditions(ctx.session);
    if (answer != null && answer.status === 'ok' && answer.conditions === 'yes') return {ok: true, client: c.client};
    return {ok: false, why: answer == null ? 'client conditions unknown' : 'the client\'s configuration could answer for the user'};
  }

  // A session locked for a kind: a latch (its client could answer forms by
  // itself, N1) is said as that, with why; a decline or two forms left
  // unanswered as a decline. Never "declined" for a latch. (The caps' alone:
  // the other kinds answer a locked session as any, their own terminal text.)
  // What holds a session's way back to the value for all sessions in conversation (the undo of its own lowering), or
  // null: 'ceiling' (the operator's ceiling turns conversation off), 'user' or 'restored' (a lock that is the user's, or
  // may be: never the latch's alone, which only says a form could be answered for the user, and the undo shows none;
  // a restored one only where a form can be shown, R-undo-after-restart), 'window' (the user's window, across sessions).
  // One function, read by the undo and by withOwnLower's sentence, so what an answer says the user can do next is
  // what the undo then does.
  function wayBackHeld(confirms, name, theCeiling) {
    if (theCeiling != null && theCeiling.state === 'trusted' && theCeiling.ceiling.conversation === false) return 'ceiling';
    const userLock = confirms.userLockOf(name);
    if (userLock === 'user' || (userLock != null && !noForms)) return userLock === 'restored' ? 'restored' : 'user';
    const confirmLib = require('./settings-confirm');
    if (confirmLib.userWindow().locked(confirmLib.kindOf(name))) return 'window';
    return null;
  }

  // A no-form answer for a session that set its own lower value ({current}) and asks above the value for all sessions:
  // the terminal command it names sets the value for all sessions, and this session keeps its own, so the answer says
  // that and the real next step (OWN_LOWER): restart the client where the way back is held, ask again here where it
  // is open, or after the user's window's pause. A value above what this runtime started with (atStart) waits for
  // its next start, said unless the answer says it already (SETTING_NEEDS_CONFIRMATION). Anything else: err as it is.
  function withOwnLower(err, session, name, next, theCeiling) {
    if (session == null || !SESSION_CAPS.includes(name) || !Number.isInteger(next)) return err;
    const sessionSettings = require('./session-settings');
    const own = sessionSettings.overridesOf(session).find((o) => o.name === name);
    if (own == null || own.loosening === true) return err;
    const current = sessionSettings.effective(session, name);
    const allNow = sessionSettings.underCeiling()[name];
    if (!(current < allNow && next > allNow)) return err;
    const hold = wayBackHeld(require('./settings-confirm').confirmations(session), name, theCeiling);
    captureAtStart();
    const later = err.code !== 'SETTING_NEEDS_CONFIRMATION' && next > atStart[name];
    const lead = OWN_LOWER.lead.replace('{current}', cliValue(name, current)).replace('{name}', name);
    err.message = `${err.message} ${lead}${OWN_LOWER[hold == null ? 'ask' : (hold === 'window' ? 'paused' : 'restart')]}${later ? OWN_LOWER.later : ''}`;
    return err;
  }

  function lockedError(confirms, name, next) {
    // the latch is the cause only of the kinds it locked (a kind declined
    // before it stays the user's decline); and only where a form could have
    // been shown: with no tested client a latched session gets the answer
    // every session gets
    if (confirms.latchedFor(name) && noForms) return CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    if (confirms.latchedFor(name)) return CountinghouseError.withFields('SETTING_CLIENT_NOT_CONFIRMED', {name: name, why: conditionsWhyLib().said(confirms.latchedWhy()), command: commandFor(name, next)});
    // a lock restored across a restart: its cause is not known here, so the
    // refusal claims neither a decline nor a latch (the reviewer's ruling (c))
    if (confirms.restoredFor(name)) return CountinghouseError.withFields('SETTING_LOCKED_THIS_SESSION', {name: name, command: commandFor(name, next)});
    return CountinghouseError.withFields('SETTING_DECLINED_THIS_SESSION', {name: name, command: commandFor(name, next)});
  }

  // The session's form, or the terminal command.
  // scope: 'all-sessions' for a change asked for all (the form names them
  // all, and its state confirms that change only), else null
  // yields: for a change that will be stored, what settings.json yielded when
  // it was decided to ask (the retry is refused if the file changed since)
  async function formForSession(name, next, old, by, ctx, scope = null, yields = undefined) {
    const session = sharedSession(ctx);
    // (a change for this session only: its own lower value may be why the terminal command would not move it)
    const own = (err) => (scope == null ? withOwnLower(err, session, name, next, ceiling()) : err);
    // the user's window first: with no room for a form of this kind, the
    // session's client is not asked at all
    if (!require('./settings-confirm').windowOpenFor(name)) {
      refuseAsked(name, next, by, 'not confirmed (too many declined or unanswered forms)', session, scope);
      throw own(CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)}));
    }
    const may = await sessionMayElicit(ctx);
    // a session that ended while its client was asked: no form, and no
    // store made for it again (its end has dropped the one it had)
    if (require('./sessions').get(session) == null) throw new CountinghouseError('MODULE_NOT_LISTED');
    const confirms = require('./settings-confirm').confirmations(session);
    // checked again after the wait: a form that expired meanwhile counts,
    // and a session the answer just given has latched is locked, as it
    // will be at every later ask
    expiredLines(confirms, by, session);
    if (confirms.declined(name)) {
      refuseAsked(name, next, by, 'not confirmed (locked in this session)', session, scope);
      throw own(lockedError(confirms, name, next));
    }
    const client = may != null && may.ok === true && may.client != null && typeof(may.client.name) === 'string' && typeof(may.client.version) === 'string' ? may.client : null;
    const why = may == null || may.ok !== true ? String((may && may.why) || 'client conditions unknown') : client == null ? 'client unknown' : null;
    // null too when the user's window has no room (too many declined or
    // unanswered forms of this kind, across the user's sessions)
    // (a cap's form: no version)
    const staged = why == null ? confirms.stage({name: name, old: old, next: next, version: null, client: client, session: session, scope: scope, yields: yields}) : null;
    if (staged == null) {
      // the form this ask left unanswered, if any, is said; it may be the
      // one that locked the kind (two left unanswered), and then that is
      // the answer
      expiredLines(confirms, by, session);
      if (why == null && confirms.declined(name)) {
        refuseAsked(name, next, by, 'not confirmed (locked in this session)', session, scope);
        throw own(lockedError(confirms, name, next));
      }
      refuseAsked(name, next, by, `not confirmed (${why || 'no form may be shown now'})`, session, scope);
      throw own(CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)}));
    }
    if (staged.replaced != null) {
      appendLine(Object.assign({by: by, setting: staged.replaced.name, asked: staged.replaced.next, change: 'replaced', session: session}, scoped(staged.replaced.scope)));
    }
    return {inputRequired: {inputRequests: {approve: formFor(name, old, next, null, {session: scope == null, all: scope != null})}, requestState: staged.requestState}};
  }

  // The retry's answer to a session's form, up to the change itself: the
  // state (for this session, this change and this scope), the user's
  // answer, the user's window, and the session's own conditions again.
  // -> {done}: answered here (the same form again, or a decline), or
  // {staged, confirms}: accepted, the change still to be checked and made.
  // scope: null, or 'all-sessions'.
  async function sessionAnswer(name, next, {requestState, inputResponses} = {}, ctx, scope) {
    const session = sharedSession(ctx);
    const by = 'settings tool';
    const confirmLib = require('./settings-confirm');
    const confirms = confirmLib.confirmations(session);
    const needs = () => CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    const retry = {name: name, next: next, session: session, scope: scope};
    const answer = inputResponses != null && typeof(inputResponses) === 'object' ? inputResponses.approve : undefined;
    // no answer: the same form again, spending no other and using nothing up
    if (answer == null || typeof(answer) !== 'object') {
      const check = confirms.check(requestState, retry);
      // a form whose time ran out is said by the store, once (expiredLines)
      expiredLines(confirms, by, session);
      if (!check.ok) throw new CountinghouseError(check.code);
      const st = check.staged;
      return {done: {inputRequired: {inputRequests: {approve: formFor(st.name, st.old, st.next, st.version, {session: scope == null, all: scope != null})}, requestState: check.requestState}}};
    }
    const v = confirms.verify(requestState, retry);
    expiredLines(confirms, by, session);
    if (!v.ok) throw new CountinghouseError(v.code);
    const staged = v.staged;
    // only an explicit true accepts: a decline, a cancel, or anything else is no
    const accepted = answer.action === 'accept' && answer.content != null && typeof(answer.content) === 'object' && answer.content.approve === true;
    if (!accepted) {
      confirms.decline(name);
      appendLine(Object.assign({by: by, setting: name, asked: next, change: 'declined', session: session}, scoped(scope)));
      return {done: {name: name, old: staged.old, new: staged.old, applies: 'declined'}};
    }
    // a yes that arrives once the kind has locked for the user is refused
    // (finding 7): three declined or unanswered forms came first
    if (confirmLib.userWindow().locked(confirmLib.kindOf(name))) {
      refuseAsked(name, next, by, 'not confirmed (too many declined or unanswered forms)', session, scope);
      throw needs();
    }
    // the session's own conditions again, now (a hook written while the dialog was up)
    const may = await sessionMayElicit(ctx);
    // a session that ended while its client was asked: answered as its
    // calls are, and nothing recorded or kept for it (its end has written
    // what it had)
    if (require('./sessions').get(session) == null) throw new CountinghouseError('MODULE_NOT_LISTED');
    const sameClient = may != null && may.client != null && staged.client != null
      && may.client.name === staged.client.name && may.client.version === staged.client.version;
    if (may == null || may.ok !== true || !sameClient) {
      refuseAsked(name, next, by, `not confirmed (${may != null && may.ok === true ? 'another client' : String((may && may.why) || 'client conditions unknown')})`, session, scope);
      throw needs();
    }
    return {staged: staged, confirms: confirms};
  }

  // The retry with the session's user's answer.
  async function confirmForSession(name, next, {requestState, inputResponses} = {}, ctx) {
    const session = sharedSession(ctx);
    if (session == null || !SESSION_CAPS.includes(name)) {
      throw CountinghouseError.withFields('SETTING_TERMINAL_ONLY_SHARED', {name: name, command: commandFor(name, next)});
    }
    const by = 'settings tool';
    const sessionSettings = require('./session-settings');
    const needs = () => CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    const front = await sessionAnswer(name, next, {requestState, inputResponses}, ctx, null);
    if (front.done != null) return front.done;
    const {staged, confirms} = front;
    const theCeiling = ceiling();
    await withLock(dir, lockWaitMs, async () => {
      const again = ceiling({cacheOnly: true});
      if (again === undefined || JSON.stringify(again) !== JSON.stringify(theCeiling)) {
        appendLine({by: by, setting: name, asked: next, change: 'not applied (ceiling changed meanwhile)', session: session});
        throw CountinghouseError.withFields('SETTING_CEILING_CHANGED_MEANWHILE', {name: name});
      }
      if (require('./sessions').get(session) == null) throw new CountinghouseError('MODULE_NOT_LISTED');
      if (confirms.declined(name)) {
        refuseAsked(name, next, by, 'not confirmed (locked in this session)', session);
        throw lockedError(confirms, name, next);
      }
      if (theCeiling != null && theCeiling.state === 'trusted' && theCeiling.ceiling.conversation === false) {
        refuseAsked(name, next, by, 'not confirmed (conversation off by the ceiling)', session);
        throw needs();
      }
      // judged against the session's value, as the form showed it
      if (sessionSettings.effective(session, name) !== staged.old) {
        appendLine({by: by, setting: name, asked: next, change: 'not applied (changed meanwhile)', session: session});
        throw CountinghouseError.withFields('SETTING_CHANGED_MEANWHILE', {name: name});
      }
      const above = ceilingRefusal(theCeiling, name, next);
      if (above != null) {
        const which = above.code === 'SETTING_CEILING_UNTRUSTED' ? 'ceiling untrusted' : above.code === 'SETTING_FORBIDDEN_BY_CEILING' ? 'forbidden by the ceiling' : 'above the ceiling';
        appendLine({by: by, setting: name, asked: next, change: `not applied (${which})`, session: session});
        throw CountinghouseError.withFields(above.code, above.fields);
      }
      // a confirmed change is one of the session's recorded changes: made
      // while its form was up, the 32 are spent
      if ((sessionChanges.get(session) || 0) >= MAX_SESSION_CHANGES) {
        refuseAsked(name, next, by, `refused, terminal only (${MAX_SESSION_CHANGES} changes made in this session)`, session);
        throw CountinghouseError.withFields('SETTING_TERMINAL_ONLY_SHARED', {name: name, command: commandFor(name, next)});
      }
      writeCounts(historyFile);
      appendLine({by: by, setting: name, old: staged.old, new: next, change: 'this session',
        confirmed: `elicitation (${staged.client.name} ${staged.client.version})`, session: session}, true);
      sessionChanges.set(session, (sessionChanges.get(session) || 0) + 1);
    });
    // told to that session alone (B2 Task 3), and logged
    const tellUser = (text) => {
      require('./notices').add(null, text, {session: session, sessionOnly: true});
      try { LOG.I(`countinghouse_settings: ${text}`); } catch (err) { /* not serving */ }
    };
    const notApplied = (err) => {
      const problem = String((err && typeof(err.code) === 'string' && err.code) || 'error').slice(0, 80);
      appendLine({by: by, setting: name, change: 'not applied', problem: problem, session: session});
      tellUser(`${name} not changed: the change you confirmed could not be applied (${problem})`);
      return (err instanceof CountinghouseError) ? err : CountinghouseError.withFields('SETTING_NOT_APPLIED_THIS_SESSION', {name: name, problem: problem});
    };
    // a raised output cap: the validators' heap first (a validator with the
    // old heap would crash on the bigger value); a growth that fails applies
    // nothing (F4)
    if (name === 'maxOutputBytes') {
      try { await growValidators(next); } catch (err) { throw notApplied(err); }
    }
    // The growth is a wait, and can take seconds. What the lock checked is
    // checked again, as the --stdio path checks after its resize, with no
    // wait from here to the override: the session (ended?), its lock (a
    // client frame that said no, a decline), the ceiling, and its value (a
    // terminal change of the default, or the session's own change, wins).
    // The history already says the change was confirmed, so each says it
    // was not applied.
    const stale = (() => {
      if (require('./sessions').get(session) == null) return {line: 'not applied (the session ended)', error: new CountinghouseError('MODULE_NOT_LISTED'), tell: false};
      if (confirms.declined(name)) {
        return {line: 'not applied (locked in this session)', error: lockedError(confirms, name, next)};
      }
      if (JSON.stringify(ceiling()) !== JSON.stringify(theCeiling)) {
        return {line: 'not applied (ceiling changed meanwhile)', error: CountinghouseError.withFields('SETTING_CEILING_CHANGED_MEANWHILE', {name: name})};
      }
      if (sessionSettings.effective(session, name) !== staged.old) {
        return {line: 'not applied (changed meanwhile)', error: CountinghouseError.withFields('SETTING_CHANGED_MEANWHILE', {name: name})};
      }
      return null;
    })();
    if (stale != null) {
      appendLine({by: by, setting: name, asked: next, change: stale.line, session: session});
      if (stale.tell !== false) tellUser(`${name} not changed: the change you confirmed was not applied (${stale.line.replace(/^not applied \(|\)$/g, '')})`);
      throw stale.error;
    }
    // the session's override: a loosening confirmed over the default in force
    try {
      sessionSettings.set(session, name, next, {loosening: true, over: options[name]});
    } catch (err) {
      throw notApplied(err);
    }
    tellUser(`${name} raised from ${cliValue(name, staged.old)} to ${cliValue(name, next)} for this session (confirmed in ${staged.client.name})`);
    return {name: name, old: staged.old, new: next, applies: 'this session'};
  }

  // A change one session asks for ALL sessions (B2 Task 5b; maintainer's
  // decision, 2026-11-14): the two caps only. It is a global change, as a terminal
  // change is. Judged against the default in force (what every session
  // runs under), never the asking session's own value.
  // - At or under it: no form. It is written to settings.json as the
  //   terminal's set writes it, applied at once (the option, every session's
  //   looser override dropped, calls under way re-armed, the workers told),
  //   and the other sessions are told. Two exceptions to the write: it never
  //   raises what the file yields (a runtime started above it by a flag, or
  //   a tighter value stored for the next start), and past the asking
  //   session's 32 recorded changes it is not stored (its history is one
  //   line and a count written later, so a stored value would be ahead of
  //   the history). Either applies to every session until the runtime
  //   restarts. Past the budget, taking back a raise stored for the next
  //   start is a tightening like any other, never refused: it changes
  //   nothing now, is answered as until the runtime restarts (the stored
  //   raise still applies at the next start), and is recorded as the
  //   others past the budget are.
  // - Above it: always the form, the asking session's own (its three
  //   forms, its locks, the user's window), which names all sessions; held
  //   to the ceiling as any loosening is.
  // The history line names the asking session, and is every session's to
  // read (readHistory); a request not made is the asking session's, and
  // says it was for all sessions.
  async function setForAll(name, next, by, ctx) {
    const session = sharedSession(ctx);
    const SCOPE = 'all-sessions';
    const terminalOnly = () => CountinghouseError.withFields('SETTING_TERMINAL_ONLY_SHARED', {name: name, command: commandFor(name, next)});
    if (session == null || !SESSION_CAPS.includes(name)) throw terminalOnly();
    const theCeiling = ceiling();
    const decided = await withLock(dir, lockWaitMs, async () => {
      if (require('./sessions').get(session) == null) throw new CountinghouseError('MODULE_NOT_LISTED');
      const {raw, values} = readFile(file);
      const inForce = options[name];
      const yields = valueOf(values, name);
      // in force and what the file yields already: nothing to do or record
      if (next === inForce && next === yields) return {done: {name: name, old: inForce, new: next, applies: 'all sessions'}};
      // in force, above what the file yields (the runtime was started above
      // it): it cannot be stored, and changes nothing now
      if (next === inForce && next > yields) return {done: {name: name, old: inForce, new: next, applies: 'all sessions, until the runtime restarts'}};
      const overBudget = (sessionChanges.get(session) || 0) >= MAX_SESSION_CHANGES;
      if (next > inForce) {
        if (overBudget) {
          refuseAsked(name, next, by, `refused, terminal only (${MAX_SESSION_CHANGES} changes made in this session)`, session, SCOPE);
          throw terminalOnly();
        }
        // no form: refused by the ceiling, conversation off by it, locked in
        // the asking session, or no forms left in it
        const above = ceilingRefusal(theCeiling, name, next);
        const confirms = require('./settings-confirm').confirmations(session);
        expiredLines(confirms, by, session);
        const noForm = above != null ? 'refused by the ceiling'
          : (theCeiling != null && theCeiling.state === 'trusted' && theCeiling.ceiling.conversation === false) ? 'not confirmed (conversation off by the ceiling)'
            : confirms.declined(name) ? 'not confirmed (locked in this session)'
              : confirms.formsLeft() <= 0 ? 'not confirmed (no forms left in this session)' : null;
        if (noForm != null) {
          refuseAsked(name, next, by, noForm, session, SCOPE);
          if (above != null) throw CountinghouseError.withFields(above.code, above.fields);
          if (confirms.declined(name)) throw lockedError(confirms, name, next);
          throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
        }
        return {ask: {old: inForce, yields: yields}};
      }
      // at or under what is in force. Stored unless that would raise what
      // the file yields; one the file yields already needs no write. Past
      // the session's budget it is not stored: its history is one line and a
      // count written later, so the file would be ahead of the history and
      // ch-local would call the runtime's own change one made outside; it
      // lasts until the runtime restarts, and the answer says so
      const kept = next <= yields && !(overBudget && next < yields);
      const live = next < inForce;
      const how = kept ? 'all sessions' : 'all sessions, until the runtime restarts';
      // said from what is in force when that changes; else from what the
      // file yielded (a stored raise awaiting the next start, taken back)
      const from = live ? inForce : yields;
      const line = {by: by, setting: name, old: from, new: next, change: how, session: session};
      if (kept && next < yields) {
        // as set writes it: the new file aside, the change recorded (one
        // the history cannot hold is not made), then the file in place
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
          fs.writeFileSync(tmp, `${JSON.stringify({version: 1, values: Object.assign({}, raw, {[name]: next})}, null, 2)}\n`);
        } catch (err) {
          fs.rmSync(tmp, {force: true});
          throw fileInvalid(`it cannot be written (${err.code || 'error'})`);
        }
        try { recordAllSessions(line, overBudget); } catch (err) { fs.rmSync(tmp, {force: true}); throw err; }
        try {
          fs.renameSync(tmp, file);
        } catch (err) {
          fs.rmSync(tmp, {force: true});
          appendLine({by: by, setting: name, change: 'all sessions: not made', problem: err.code || 'error', session: session});
          throw fileInvalid(`it cannot be replaced (${err.code || 'error'})`);
        }
      } else {
        recordAllSessions(line, overBudget);
      }
      sessionChanges.set(session, (sessionChanges.get(session) || 0) + 1);
      // applied now, as a terminal tightening is: the option, each
      // session's looser override dropped and that session told, the
      // timers of calls under way
      if (live) {
        captureAtStart();
        options[name] = next;
        terminalTightened(name, next);
      }
      try { LOG.I(`countinghouse_settings: ${name} changed from ${JSON.stringify(from)} to ${JSON.stringify(next)} by ${by}, for all sessions`); } catch (err) { /* not serving */ }
      return {done: {name: name, old: from, new: next, applies: how}, live: live};
    });
    if (decided.ask != null) return formForSession(name, next, decided.ask.old, by, ctx, SCOPE, decided.ask.yields);
    if (decided.live === true) {
      // every running module worker, for its own checks and timers; and
      // the other sessions hear of it
      broadcastLiveOptions(liveModules != null ? liveModules() : null);
      tellOthers(session, name, next);
    }
    return decided.done;
  }

  // every live session but the one that asked
  function tellOthers(session, name, next) {
    require('./notices').add(null, `${name} changed to ${cliValue(name, next)} for all sessions (changed from another session)`, {except: session});
  }

  // The retry with the asking session's user's answer to an all-sessions
  // form. For a raised output cap the validators grow first: a wait (it
  // can take seconds) that changes nothing. Then ONE lock, with no wait in
  // it: everything is checked as it is then (the session, its lock, the
  // ceiling, the default in force, the file as the form saw it, the
  // session's 32 changes); the file is written as the terminal's set writes
  // it (aside, the history line, in place); and the value is put in force
  // for every session (the option, the start value, the workers). So a
  // change that cannot be stored is not in force, one checked is not
  // overtaken, and the file never holds what a terminal change meanwhile
  // would have made it.
  async function confirmForAll(name, next, {requestState, inputResponses} = {}, ctx) {
    const session = sharedSession(ctx);
    const SCOPE = 'all-sessions';
    const terminalOnly = () => CountinghouseError.withFields('SETTING_TERMINAL_ONLY_SHARED', {name: name, command: commandFor(name, next)});
    if (session == null || !SESSION_CAPS.includes(name)) throw terminalOnly();
    const by = 'settings tool';
    const needs = () => CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    const front = await sessionAnswer(name, next, {requestState, inputResponses}, ctx, SCOPE);
    if (front.done != null) return front.done;
    const {staged, confirms} = front;
    // told to the asking session alone, and logged
    const tellAsker = (text) => {
      require('./notices').add(null, text, {session: session, sessionOnly: true});
      try { LOG.I(`countinghouse_settings: ${text}`); } catch (err) { /* not serving */ }
    };
    const notApplied = (problem) => {
      appendLine({by: by, setting: name, change: 'not applied', problem: problem, session: session, scope: SCOPE});
      tellAsker(`${name} not changed: the change you confirmed for all sessions could not be applied (${problem})`);
      return CountinghouseError.withFields('SETTING_NOT_APPLIED_ALL_SESSIONS', {name: name, problem: problem});
    };
    // every module worker holds its own copy of the option: with none to
    // tell, nothing can be put in force (as applyConfirmed has it)
    if (liveModules == null) throw notApplied('no running modules to tell');
    if (name === 'maxOutputBytes') {
      try {
        await growValidators(next);
      } catch (err) {
        throw notApplied(String((err && typeof(err.code) === 'string' && err.code) || 'error').slice(0, 80));
      }
    }
    // the ceiling read before the lock (on Windows a read spawns PowerShell)
    const theCeiling = ceiling();
    const ownWas = await withLock(dir, lockWaitMs, async () => {
      const refuseNow = (line, error) => {
        appendLine({by: by, setting: name, asked: next, change: line, session: session, scope: SCOPE});
        return error;
      };
      const again = ceiling({cacheOnly: true});
      if (again === undefined || JSON.stringify(again) !== JSON.stringify(theCeiling)) {
        throw refuseNow('not applied (ceiling changed meanwhile)', CountinghouseError.withFields('SETTING_CEILING_CHANGED_MEANWHILE', {name: name}));
      }
      if (require('./sessions').get(session) == null) throw new CountinghouseError('MODULE_NOT_LISTED');
      if (confirms.declined(name)) {
        refuseAsked(name, next, by, 'not confirmed (locked in this session)', session, SCOPE);
        throw lockedError(confirms, name, next);
      }
      if (theCeiling != null && theCeiling.state === 'trusted' && theCeiling.ceiling.conversation === false) {
        refuseAsked(name, next, by, 'not confirmed (conversation off by the ceiling)', session, SCOPE);
        throw needs();
      }
      // judged against the default in force, as the form showed it: a
      // terminal change, or another session's for all, meanwhile wins
      if (options[name] !== staged.old) {
        throw refuseNow('not applied (changed meanwhile)', CountinghouseError.withFields('SETTING_CHANGED_MEANWHILE', {name: name}));
      }
      const above = ceilingRefusal(theCeiling, name, next);
      if (above != null) {
        const which = above.code === 'SETTING_CEILING_UNTRUSTED' ? 'ceiling untrusted' : above.code === 'SETTING_FORBIDDEN_BY_CEILING' ? 'forbidden by the ceiling' : 'above the ceiling';
        throw refuseNow(`not applied (${which})`, CountinghouseError.withFields(above.code, above.fields));
      }
      if ((sessionChanges.get(session) || 0) >= MAX_SESSION_CHANGES) {
        refuseAsked(name, next, by, `refused, terminal only (${MAX_SESSION_CHANGES} changes made in this session)`, session, SCOPE);
        throw terminalOnly();
      }
      // the file as the form saw it: one changed since (a terminal change
      // written, its control set not here yet) is the terminal's, and is
      // not written over
      const {raw, values} = readFile(file);
      if (valueOf(values, name) !== staged.yields) {
        throw refuseNow('not applied (changed meanwhile)', CountinghouseError.withFields('SETTING_CHANGED_MEANWHILE', {name: name}));
      }
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, `${JSON.stringify({version: 1, values: Object.assign({}, raw, {[name]: next})}, null, 2)}\n`);
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        throw fileInvalid(`it cannot be written (${err.code || 'error'})`);
      }
      writeCounts(historyFile);
      try {
        appendLine({by: by, setting: name, old: staged.old, new: next, change: 'all sessions',
          confirmed: `elicitation (${staged.client.name} ${staged.client.version})`, session: session}, true);
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        throw err;
      }
      try {
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, {force: true});
        appendLine({by: by, setting: name, change: 'all sessions: not made', problem: err.code || 'error', session: session});
        throw fileInvalid(`it cannot be replaced (${err.code || 'error'})`);
      }
      sessionChanges.set(session, (sessionChanges.get(session) || 0) + 1);
      // in force for every session: the option, the value a later control
      // set is measured against, and every module worker
      captureAtStart();
      options[name] = next;
      if (next > atStart[name]) atStart[name] = next;
      broadcastLiveOptions(liveModules());
      // the session that asked gets the value too: its own lower value for
      // this setting goes (the form it accepted said all sessions). Another
      // session's own tighter value is its own, and stays.
      const sessionSettings = require('./session-settings');
      const own = sessionSettings.overridesOf(session).find((o) => o.name === name);
      return (own != null && own.value < next) ? sessionSettings.clear(session, name) : null;
    });
    tellAsker(`${name} raised from ${cliValue(name, staged.old)} to ${cliValue(name, next)} for all sessions (confirmed in ${staged.client.name})${ownWas != null ? `; this session's own ${cliValue(name, ownWas)} no longer applies` : ''}`);
    tellOthers(session, name, next);
    return {name: name, old: staged.old, new: next, applies: 'all sessions'};
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
            : confirms.formsLeft() <= 0 ? 'no forms left this start' : null;
    const staged = why == null ? confirms.stage({name: name, old: old, next: next, version: null, client: client, session: session}) : null;
    if (staged == null) {
      refuseAsked(name, next, by, `not confirmed (${why || 'no forms left this start'})`);
      throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    }
    const {requestState, replaced} = staged;
    if (replaced != null) appendLine({by: by, setting: replaced.name, asked: replaced.next, change: 'replaced'});
    return {inputRequired: {inputRequests: {approve: formFor(name, old, next, null)}, requestState: requestState}};
  }

  // The retry with the user's answer. -> {name, old, new, applies: 'this
  // start' | 'declined'}, a fresh {inputRequired} when there is no answer, or
  // throws.
  async function confirm(name, value, {requestState, inputResponses} = {}, ctx = {}) {
    // a module setting's form: every session of the user, whatever the scope
    if (typeof(name) === 'string' && MODULE_SETTING.test(name)) return confirmModule(name, value, {requestState, inputResponses}, ctx);
    if (typeof(name) === 'string' && ENABLED.test(name)) return confirmEnabled(name, value, {requestState, inputResponses}, ctx);
    const e = entryOf(name);
    if (e == null) throw CountinghouseError.withFields('SETTING_UNKNOWN', {name: String(name).slice(0, 80)});
    const next = e.parse(value);
    if (next == null || Number.isNaN(next) || !validStored(e, next)) {
      throw CountinghouseError.withFields('SETTING_OUT_OF_BOUNDS', {name: name, value: String(value).slice(0, 80), bounds: boundsText(e)});
    }
    const scope = scopeOf(ctx);
    // a shared runtime's session: its own store, and its own value and
    // override, or the change it asked for all sessions
    if (ctx != null && ctx.shared === true) {
      try {
        return await inSessionPath(sharedSession(ctx), () => (scope != null ? confirmForAll(name, next, {requestState, inputResponses}, ctx) : confirmForSession(name, next, {requestState, inputResponses}, ctx)));
      } finally {
        // the answer's outcome is applied, or refused: the session's state
        // as it now stands is told, once (nothing, when it was told already)
        require('./settings-confirm').announceFor(ctx.session);
      }
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
    // which loads it. A change confirmed in conversation is its session's:
    // in a shared runtime it is told to that session alone (B2 Task 3); a
    // terminal change is everyone's (ch-local's control notice).
    const tellUser = (text) => {
      require('./notices').add(null, text, {session: ctx != null ? ctx.session : null, sessionOnly: true});
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
    tellUser(`${name} raised from ${cliValue(name, staged.old)} to ${cliValue(name, next)} for this start (confirmed in ${staged.client.name})`);
    return {name: name, old: shown(staged.old), new: shown(next), applies: 'this start'};
  }

  // One history line; strict: a line that cannot be written refuses (a
  // change the history cannot hold is not made).
  // A line that doesn't name the session whose path it is written in
  // throws, strict or not (checkPath).
  function appendLine(line, strict = false) {
    checkPath(line);
    try {
      appendHistoryLine(historyFile, line);
    } catch (err) {
      if (strict) throw new CountinghouseError('SETTING_NOT_RECORDED');
    }
  }

  // A request not made: recorded once per kind and outcome, and said.
  // scope: 'all-sessions' for a request made for all sessions, recorded as
  // one and counted apart from the session's own requests
  // whether a session (null: the runtime's own) may have another module
  // setting's refusal line in this window; taken when it may
  function moduleLineRoom(session) {
    if (!MODULE_LINES.has(historyFile)) MODULE_LINES.set(historyFile, new Map());
    const bySession = MODULE_LINES.get(historyFile);
    const key = storeKeyOf(session);
    const at = clock();
    const kept = (bySession.get(key) || []).filter((t) => at - t < WINDOW_MS);
    if (kept.length >= MODULE_LINES_PER_WINDOW) { bySession.set(key, kept); return false; }
    bySession.set(key, kept.concat([at]));
    return true;
  }

  function refuseAsked(name, next, by, change, session = null, scope = null) {
    // a reason (some from outside: ch-local's) as one plain line, cut
    // (lib/module-text.js moduleLine), so one with a stray control groups
    // with the same reason without one; none left is said as "(none)" in the
    // history line, its group's key and the log line, never an empty string
    change = moduleLine(change, 120) || '(none)';
    let written;
    try { written = recordAsked(name, next, by, change, session, scope); } catch (err) { throw new CountinghouseError('SETTING_NOT_RECORDED'); }
    if (written) { try { LOG.I(`countinghouse_settings: ${name} to ${JSON.stringify(shown(next))} asked for by ${by}, ${change}`); } catch (err) { /* not serving */ } }
  }

  // change: 'not confirmed' or 'refused, terminal only'. -> true when a
  // history line was written (the first of its kind this start).
  // session: a shared runtime's session's request, grouped and recorded as
  // its own (F8).
  function recordAsked(name, next, by, change, session = null, scope = null) {
    const pending = pendingFor(historyFile);
    // grouped per kind and outcome (the reason aside, the first one kept),
    // so a count is never filed under another's and varying reasons add none
    // (a module setting's requests per setting: one kind's lock, each its own count)
    const group = (kindOf(name) === 'module') ? name : kindOf(name);
    const kind = `${session != null ? session : ''}\0${group}\0${String(change).replace(/ \(.*$/, '')}\0${scope != null ? scope : ''}`;
    // its session is the line's and its counts' (writeCounts)
    checkPath(session != null ? {session: session} : {});
    const p = pending.get(kind);
    // (an applied change's count carries the value it came to: L3)
    if (p != null) { p.count += 1; if (p.applied === true) p.latest = next; return false; }
    // a module setting not yet refused: its own line, within the window's
    // bound; past it, counted on the one line for the rest
    // (the 'more' line counts distinct settings: a setting asked again is
    // not another one)
    if (kindOf(name) === 'module' && !moduleLineRoom(session)) {
      const more = `${storeKeyOf(session)}\0module settings\0more\0${scope != null ? scope : ''}`;
      const m = pending.get(more);
      if (m == null) pending.set(more, {setting: 'module settings', by: by, change: 'refused', count: 1, written: 0, session: session, scope: scope, more: true, names: new Set([name]), clock: clock, flushedAt: null});
      else if (!m.names.has(name)) { m.names.add(name); m.count += 1; }
      return false;
    }
    // (an applied change -- a tightening past the budget, a cap's number
    // only, never a module.* value -- is said as one: `new`, never `asked`,
    // which says a change not made; the medium on the round, 3-4)
    const applied = APPLIED(change) && kindOf(name) !== 'module';
    appendHistoryLine(historyFile, Object.assign({by: by, setting: name}, applied ? {new: next} : {asked: next}, {change: change}, session != null ? {session: session} : {}, scoped(scope)));
    pending.set(kind, {setting: kindOf(name) === 'enabled' ? 'enabled' : name, by: by, change: change, count: 1, written: 1, session: session, scope: scope,
      ...(applied ? {applied: true, latest: next} : {})});
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

  // (each after ch-local's held-back list is read, as the overview is: a
  // command a refusal names goes through the launcher it gives, never the
  // bare form of the empty list before its first read -- on Windows the
  // read ahead takes seconds: the medium on the launcher fix, 1)
  const afterHeldBack = (fn) => (...a) => heldBackReady().then(() => fn(...a), () => fn(...a));
  return {get: afterHeldBack(get), set: afterHeldBack(set), confirm: afterHeldBack(confirm), refuseSharedSet, writeCounts: () => writeCounts(historyFile)};
}

// ch-local start's control `set {name, value}`, the value in the runtime's
// unit, as its option takes it (--requestTimeout in seconds). It takes effect for the next call: a running call keeps the
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
// start, and says so.
const {LIVE_FIELDS, applyLiveOptions} = require('./live-options');
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
// A terminal change of a cap binds every session at once (B2 Task 2; #236
// section 3): each session override looser than the new default is dropped,
// and every call under way is re-armed (its reply cap already takes the
// tighter at its next check). A loosening touches no override. Each session
// whose override was dropped is told so, and no other (B2 Task 3).
function terminalTightened(name, value) {
  const dropped = require('./session-settings').dropLooser(name, value);
  if (name === 'requestTimeout') require('./session').rearmAll();
  for (const id of dropped) {
    require('./notices').add(null, `your this-session loosening of ${name} ended: the default was lowered to ${cliValue(name, value)}`, {session: id});
  }
  return dropped;
}

function applyControlSet(msg) {
  const name = msg != null ? msg.name : null;
  const value = msg != null ? msg.value : null;
  captureAtStart();
  switch (name) {
    case 'maxOutputBytes':
      if (!validStored(ALLOWLIST.maxOutputBytes, value)) return {ok: false, code: 'SETTING_OUT_OF_BOUNDS'};
      if (aboveControlCeiling('maxOutputBytes', value)) return {ok: false, code: 'SETTING_ABOVE_CEILING'};
      if (value > atStart.maxOutputBytes) return {ok: false, code: 'CONTROL_APPLIES_AT_START'};
      const wasBytes = options.maxOutputBytes;
      options.maxOutputBytes = value;
      if (value < wasBytes) terminalTightened('maxOutputBytes', value);
      return {ok: true};
    case 'requestTimeout': {
      const msValue = Number.isInteger(value) ? value * 1000 : NaN;
      if (!validStored(ALLOWLIST.requestTimeout, msValue)) return {ok: false, code: 'SETTING_OUT_OF_BOUNDS'};
      if (aboveControlCeiling('requestTimeout', msValue)) return {ok: false, code: 'SETTING_ABOVE_CEILING'};
      if (msValue > atStart.requestTimeout) return {ok: false, code: 'CONTROL_APPLIES_AT_START'};
      const wasMs = options.requestTimeout;
      options.requestTimeout = msValue;
      if (msValue < wasMs) terminalTightened('requestTimeout', msValue);
      return {ok: true};
    }
    default:
      // a module is turned off by its enabled.<module> in the file (ch-local
      // unloads it), and the others apply at the next start; the CONTROL_*
      // codes stay internal
      return {ok: false, code: entryOf(name) != null ? 'CONTROL_NOT_LIVE' : 'CONTROL_UNKNOWN_SETTING'};
  }
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {type: 'string', enum: ['get', 'set']},
    name: {type: 'string', description: 'set: the setting, as get lists it (enabled.<module> turns a module off for every session; module.<package>.<setting> is a module\'s setting)'},
    cursor: {type: 'string', description: 'get: the nextCursor a previous get gave, for the modules\' rows after it (their on/off, then their settings)'},
    value: {type: ['string', 'number', 'boolean'], description: 'set: the new value, within its bounds (sizes like 4MiB, times like 20s, on/off)'},
    scope: {type: 'string', enum: ['all-sessions'], description: 'set, on a runtime that serves several of the user\'s sessions, and only when the user asked for it: '
      + 'all-sessions changes maxOutputBytes or requestTimeout for every session and keeps it; without it a change is this session\'s only'}
  },
  required: ['action'],
  additionalProperties: false
};

// The options a control set changes, as a module worker holds them: sent to
// every running module worker after a set (broadcastLiveOptions), so a
// worker started after a tighten, holding the tighter value, takes a
// loosening back up too. A worker started later reads the current values
// (getOptionsForWorker).
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
// (a worker's: lib/live-options.js applyLiveOptions)

// For tests: forget the values recorded at the first control set and the
// cached ceiling; ceilingForControl(fn) replaces the control set's ceiling.
function resetForTests() { atStart = null; started = null; ceilingCache = null; sessionChanges.clear(); stagedModuleForms.clear(); MODULE_LINES.clear(); }
function ceilingForControl(fn) { controlCeiling = fn; }
// The operator's ceiling as the control channel's backstops read it (cached
// until its file or a directory above it changes): packs in place checks its
// packs allowlist at load and reload (lib/modules-in-place.js).
function controlCeilingNow() { return controlCeiling(); }
// The ceiling the modules' settings are made under (its fixed values; one
// that cannot be trusted refuses a load and a reread): where the settings
// tool is served (the single-identity profile with a settings file), as it
// binds a load there; elsewhere none does (lib/module-manager.js,
// lib/settings-reread.js).
function moduleCeilingNow() { return options.settingsTool === true ? controlCeiling() : null; }


// The line every session is told by of a caller unloaded with a module
// turned off (lib/module-control.js, reason 'calls'): within the notice's
// own bound, the way back whole (the medium review of round 5, 2 and 8)
function callsNotice(name, because) {
  const max = require('./notices').OWN_NOTICE_MAX;
  const full = `${name} unloaded: it calls ${because}, which is turned off for all your sessions (turning ${because} on brings it back).`;
  return full.length <= max ? full : `${name} unloaded: it calls ${because}, which is turned off for all your sessions (turning it on brings it back).`;
}

// the callers as a sentence names them, and its verbs: {names, verb: calls
// or call, does: does or do}; k 0 names none ("A module", "3 modules")
function callersPhrase(callers, k) {
  const n = callers.length;
  return {names: k === 0 ? (n === 1 ? 'A module' : `${n} modules`) : callerNames(callers, k), verb: n === 1 ? 'calls' : 'call', does: n === 1 ? 'does' : 'do'};
}
// the manager a tool was given, or a clear error
function managerOf(mm) {
  if (mm == null) throw new Error('the settings tool was given no module manager (lib/mcp/gateway.js passes it)');
  return mm;
}

// callers named, at most k of them and how many more: "a, b and 2 more"
// (k at least 1; callers not empty)
function callerNames(callers, k) {
  const shown = callers.length > k ? callers.slice(0, k).concat(`${callers.length - k} more`) : callers;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

// The sentence every session is told by of a module turned off (section
// 5.3): what went with it and the way back, at a terminal (a session where no
// form is shown is refused it here: runtime-claims 1). Told by ch-local's unload of
// it with reason 'off' (lib/module-control.js), never by the settings tool.
function offNotice(pkg, callers) {
  const undo = enabledCommand(pkg, true);
  const way = `at a terminal: \`${undo}\``;
  if (callers.length === 0) return `${pkg} is turned off for all your sessions. It stays off until it is turned on again ${way}.`;
  // at most eight named, and how many more; fewer, down to none, and the
  // module named once less, until the sentence fits the notice's own bound
  // (lib/notices.js OWN_NOTICE_MAX), so the way back is never cut (the
  // medium review of round 3, 7)
  const max = require('./notices').OWN_NOTICE_MAX;
  const n = callers.length;
  let text = '';
  for (let k = Math.min(8, n); k >= 0; k--) {
    const {names, verb} = callersPhrase(callers, k);
    const offToo = n === 1 ? (k === 0 ? 'that module is' : `${names} is`) : 'they are';
    for (const again of [pkg, 'it']) {
      text = `${pkg} is turned off for all your sessions. ${names} ${verb} it, so ${offToo} off too. They stay off until ${again} is turned on again ${way}.`;
      if (text.length <= max) return text;
    }
  }
  return text;
}

module.exports = {OWN_LOWER, commandFor, readFile, ENABLED, topLevelModules, installedPacks, installedOwn, upgradeAvailable, UNREADABLE, offNotice, callsNotice, callersIn, MODULE_SETTING, create, cachedCeiling, applyConfirmed, captureAtStart, setLiveModules, applyControlSet, liveOptions, broadcastLiveOptions, applyLiveOptions, resetForTests, ceilingForControl, controlCeilingNow, moduleCeilingNow, onCeilingChange, ALLOWLIST, INPUT_SCHEMA,
  forgetSession, primeCeiling, watchCeiling, recordReplayed, recordUnanswered, inSessionPath, appendHistoryLine};
