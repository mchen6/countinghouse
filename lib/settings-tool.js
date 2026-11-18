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
// the latch's why, in the refusal's sentence (loaded once, on first use)
const conditionsWhyLib = require('./require-once')(() => require('./conditions-why'));
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
// a pack's name, the one grammar for it (the gateway and lib/pack-control.js
// take these): <n>, and the setting pack.<n>
const PACK_NAME_SOURCE = '[a-z0-9][a-z0-9-]{0,63}';
const PACK_NAME = new RegExp(`^${PACK_NAME_SOURCE}$`);
const PACK = new RegExp(`^pack\\.(${PACK_NAME_SOURCE})$`);
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
// A shared runtime's session may change these two for itself, in
// conversation (B2: the per-session overrides); every other setting is the
// terminal's there.
const {CAPS: SESSION_CAPS} = require('./session-settings');
// The changes one session may write to the history. The history is one
// file, read by its 64 KiB tail, and a line that names a session is shown
// to that session only: a session stepping a cap down call after call would
// push every other reader's lines out of the tail. Past this many its
// changes are the terminal's (asked and refused, recorded once and counted).
const MAX_SESSION_CHANGES = 32;
const sessionChanges = new Map();   // session id -> changes it has recorded
// A session's end: the counts of its repeated requests are written, and
// nothing of it is kept (lib/sessions.js close).
function forgetSession(session) {
  sessionChanges.delete(session);
  for (const [historyFile, pending] of UNCONFIRMED) {
    if (![...pending.values()].some((p) => p.session === session)) continue;
    writeCounts(historyFile, session);
    for (const [kind, p] of [...pending]) if (p.session === session) pending.delete(kind);
  }
}
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
function appendHistoryLine(historyFile, line) {
  checkPath(line);
  fs.appendFileSync(historyFile, `${JSON.stringify(Object.assign({at: new Date().toISOString()}, line))}\n`);
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
      fs.appendFileSync(historyFile, `${JSON.stringify(Object.assign({at: new Date().toISOString(), by: 'settings tool', setting: gone.name, asked: gone.next, change: 'expired', session: session}, scoped(gone.scope)))}\n`);
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
// The counts not yet written, as history lines (called with the lock held, or
// at exit); only: one session's (at its end).
function writeCounts(historyFile, only = null) {
  const pending = UNCONFIRMED.get(historyFile);
  if (pending == null) return;
  for (const p of pending.values()) {
    if (p.count <= p.written || (only != null && p.session !== only)) continue;
    const line = {at: new Date().toISOString(), by: p.by, setting: p.setting, change: `${p.change}, asked again`, count: p.count - p.written};
    // a session's request, counted for it (get shows it to that session only)
    if (p.session != null) line.session = p.session;
    if (p.scope != null) line.scope = p.scope;
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
  const stamp = (st) => `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}:${st.uid}`;
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
  const stale = ceilingCache == null || ceilingCache.key !== key || (platform === 'win32' && now() - ceilingCache.at >= WINDOWS_CEILING_AGE_MS);
  if (stale) {
    ceilingCache = {key: key, at: now(), value: read()};
    // a re-read ceiling: every session's stored loosenings are clamped to it
    // (lib/session-settings.js ceilingSeen; idle sessions too)
    try { require('./session-settings').ceilingSeen(ceilingCache.value); } catch (e) { /* not this runtime's concern */ }
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
    // a shared runtime's session (B2 Task 5): the change is that session's only
    session: {
      maxOutputBytes: (o, n) => `Allow countinghouse tools to return up to ${n} per call in this session (now ${o})? This applies to this session only, until it ends.`,
      requestTimeout: (o, n) => `Allow countinghouse tool calls to run for up to ${n} in this session (now ${o})? This applies to this session only, until it ends.`,
      // a pack for this session (B3 Task 8)
      pack: (p, v) => `Turn on the ${p} ${v} tools in countinghouse for this session? This applies to this session only, until it ends.`
    },
    // one session asking for all (B2 Task 5b): a global change, kept
    all: {
      maxOutputBytes: (o, n) => `Allow countinghouse tools in all your sessions to return up to ${n} per call (now ${o})? This changes the setting for every session, now and after a restart.`,
      requestTimeout: (o, n) => `Allow countinghouse tool calls in all your sessions to run for up to ${n} (now ${o})? This changes the setting for every session, now and after a restart.`
    },
    title: 'Approve'
  },
  zh: {
    maxOutputBytes: (o, n) => `允许 countinghouse 工具每次调用最多返回 ${n}（当前为 ${o}）吗？此设置在你的客户端重新启动 countinghouse 之前一直有效。`,
    requestTimeout: (o, n) => `允许 countinghouse 工具每次调用最长运行 ${n}（当前为 ${o}）吗？此设置在你的客户端重新启动 countinghouse 之前一直有效。`,
    pack: (p, v) => `要在 countinghouse 中启用工具包 ${p}（${v}）吗？此设置在你的客户端重新启动 countinghouse 之前一直有效。`,
    session: {
      maxOutputBytes: (o, n) => `允许 countinghouse 工具在本会话中每次调用最多返回 ${n}（当前为 ${o}）吗？此设置仅对本会话有效，会话结束即失效。`,
      requestTimeout: (o, n) => `允许 countinghouse 工具在本会话中每次调用最长运行 ${n}（当前为 ${o}）吗？此设置仅对本会话有效，会话结束即失效。`,
      pack: (p, v) => `要在本会话中启用 countinghouse 工具包 ${p}（${v}）吗？此设置仅对本会话有效，会话结束即失效。`
    },
    all: {
      maxOutputBytes: (o, n) => `允许 countinghouse 工具在你的所有会话中每次调用最多返回 ${n}（当前为 ${o}）吗？此更改对所有会话生效，重启后仍然有效。`,
      requestTimeout: (o, n) => `允许 countinghouse 工具在你的所有会话中每次调用最长运行 ${n}（当前为 ${o}）吗？此更改对所有会话生效，重启后仍然有效。`
    },
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
// session: the form of a shared runtime's session (the two caps), which
// says the change is that session's only; all: the form of a change one
// session asks for all sessions, which names them all
function formFor(name, old, next, version, {session = false, all = false} = {}) {
  const text = FORM_TEXT[options.locale === 'zh-CN' ? 'zh' : 'en'];
  const pack = PACK.exec(name);
  const message = pack != null ? (session ? text.session.pack(pack[1], version) : text.pack(pack[1], version))
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
const HISTORY_FIELDS = ['at', 'by', 'setting', 'old', 'new', 'change', 'loosened', 'problem', 'notice', 'asked', 'count', 'confirmed', 'scope'];
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
    const forAll = typeof(entry.change) === 'string' && entry.change.startsWith('all sessions');
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
// sessionClient, growValidators: a test's (a shared runtime's session: the
// tested-client check of its request, and the validators' growth before a
// raised output cap applies).
function create({file, lockWaitMs = LOCK_WAIT_MS, ceiling = (o) => cachedCeiling(() => require('./settings-ceiling').readCeiling(), o),
  allowlist = require('./elicitation-clients').ALLOWLIST, mayElicit = (ctx) => defaultMayElicit(ctx, allowlist), applyChange = defaultApplyChange,
  sessionClient = (ctx) => require('./elicitation-clients').clientMayElicit(ctx || {}, allowlist),
  growValidators = (bytes) => require('./validator-pool').growFor(bytes),
  // ch-local's daemon asked (a session's load-pack, B3 Task 8)
  ask = (msg, opts) => require('./control-channel').ask(msg, opts)}) {
  const dir = path.dirname(file);
  const historyFile = path.join(dir, 'history.jsonl');

  // ctx.shared (a shared runtime's session, B2 Task 4): the two caps are
  // shown at the session's own effective values, and the history is the
  // session's view of it (readHistory).
  async function get(ctx = {}) {
    const session = sharedSession(ctx);
    const {values} = readFile(file);
    const c = ceiling();
    // a session's own pack overrides are rows too (B3 Task 8)
    const own = session != null ? [...require('./session-settings').packOverridesOf(session).keys()].map((p) => `pack.${p}`) : [];
    const names = [...Object.keys(ALLOWLIST), ...[...new Set([...Object.keys(values).filter((n) => PACK.test(n)), ...own])].sort()];
    return {
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
        const ofSession = session != null && (SESSION_CAPS.includes(name) || PACK.test(name));
        const value = ofSession ? require('./session-settings').effective(session, name) : isCap(name) ? effectiveOf(values, name) : valueOf(values, name);
        const stored = (!ofSession && isCap(name) && isStored(values, name) && values[name] !== value) ? {stored: shown(values[name])} : {};
        return Object.assign({name: name, value: shown(value)}, stored, {default: shown(e.default), bounds: bounds, guarding: e.guarding, applies: e.applies});
      }),
      history: readHistory(historyFile, session)
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
      // a value equal to the file's and to this runtime's changes nothing and
      // records nothing, so a repeated no-op cannot push real entries out of
      // get's view. (One the runtime only started with, under the default,
      // is not in the file: asked for, it is stored below when it may be
      // (storable), so it holds when the ceiling or the flag that gave it is
      // gone.)
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
      // with nothing stored, a cap this runtime now runs UNDER the value
      // asked for (lowered for this start, or brought down by ch-local)
      const aboveWhatRuns = isCap(name) && !isStored(values, name) && next > effective;
      // the file's value already, this runtime still on another (a terminal
      // change awaiting the next start): nothing to write. Not the start
      // value asked for once the runtime runs under it: that is a raise of
      // what runs (below), as any value between is.
      if (next === old && kept && !aboveWhatRuns) return {done: {name: name, old: shown(old), new: shown(next), applies: 'next start'}};
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
      const from = (begun != null && next <= effective) ? effective : yields;
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
      // a pack's value written to the file is what governs it now: this
      // start's turn-on (ch-local drops its own on the same change) is over
      if (PACK.test(name)) packsThisStart.delete(name);
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
  // names the session. Every other setting is the terminal's.
  async function setForSession(name, next, by, ctx) {
    const session = sharedSession(ctx);
    const terminalOnly = () => CountinghouseError.withFields('SETTING_TERMINAL_ONLY_SHARED', {name: name, command: commandFor(name, next)});
    if (session == null || !(SESSION_CAPS.includes(name) || PACK.test(name))) throw terminalOnly();
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
      if ((sessionChanges.get(session) || 0) >= MAX_SESSION_CHANGES) {
        refuseAsked(name, next, by, `refused, terminal only (${MAX_SESSION_CHANGES} changes made in this session)`, session);
        throw terminalOnly();
      }
      if (sessionSettings.isLoosening(session, name, next)) {
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
          if (confirms.declined(name)) throw lockedError(confirms, name, next);
          throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
        }
        // the form is decided outside the lock (the session's client is asked)
        return {ask: {old: old}};
      }
      // recorded first: a change the history cannot hold is not made
      writeCounts(historyFile);
      appendLine({by: by, setting: name, old: old, new: next, change: 'this session', session: session}, true);
      try {
        // a pack turned off names the version it was off at (the loaded
        // one, else packs.json's): the state's pack override always names
        // one, and an export leaves one without out (B3 Task 9)
        const offPack = PACK.exec(name);
        sessionSettings.set(session, name, next, offPack != null ? {version: require('./session-packs').loadedVersion(offPack[1]) || packVersion(dir, name)} : {});
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
      try { LOG.I(`countinghouse_settings: ${name} changed from ${JSON.stringify(old)} to ${JSON.stringify(next)} by ${by}, for one session`); } catch (err) { /* not serving */ }
      return {done: {name: name, old: old, new: next, applies: 'this session'}};
    });
    if (decided.done != null) return decided.done;
    return formForSession(name, next, decided.ask.old, by, ctx);
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
  // unanswered as a decline. Never "declined" for a latch.
  function lockedError(confirms, name, next) {
    // the latch is the cause only of the kinds it locked (a kind declined
    // before it stays the user's decline)
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
    // the user's window first: with no room for a form of this kind, the
    // session's client is not asked at all
    if (!require('./settings-confirm').windowOpenFor(name)) {
      refuseAsked(name, next, by, 'not confirmed (too many declined or unanswered forms)', session, scope);
      throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
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
      throw lockedError(confirms, name, next);
    }
    const client = may != null && may.ok === true && may.client != null && typeof(may.client.name) === 'string' && typeof(may.client.version) === 'string' ? may.client : null;
    const why = may == null || may.ok !== true ? String((may && may.why) || 'client conditions unknown') : client == null ? 'client unknown' : null;
    // null too when the user's window has no room (too many declined or
    // unanswered forms of this kind, across the user's sessions)
    // a pack's version, as packs.json gives it (B3 Task 8): none, no form
    const version = PACK.test(name) ? packVersion(dir, name) : null;
    const noVersion = PACK.test(name) && version == null ? 'no version for the pack in packs.json' : null;
    const staged = why == null && noVersion == null ? confirms.stage({name: name, old: old, next: next, version: version, client: client, session: session, scope: scope, yields: yields}) : null;
    if (staged == null) {
      // the form this ask left unanswered, if any, is said; it may be the
      // one that locked the kind (two left unanswered), and then that is
      // the answer
      expiredLines(confirms, by, session);
      if (why == null && confirms.declined(name)) {
        refuseAsked(name, next, by, 'not confirmed (locked in this session)', session, scope);
        throw lockedError(confirms, name, next);
      }
      refuseAsked(name, next, by, `not confirmed (${why || noVersion || 'no form may be shown now'})`, session, scope);
      throw CountinghouseError.withFields('SETTING_NEEDS_CONFIRMATION', {name: name, value: cliValue(name, next), command: commandFor(name, next)});
    }
    if (staged.replaced != null) {
      appendLine(Object.assign({by: by, setting: staged.replaced.name, asked: staged.replaced.next, change: 'replaced', session: session}, scoped(staged.replaced.scope)));
    }
    return {inputRequired: {inputRequests: {approve: formFor(name, old, next, version, {session: scope == null, all: scope != null})}, requestState: staged.requestState}};
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
    if (session == null || !(SESSION_CAPS.includes(name) || PACK.test(name))) {
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
    // a pack (B3 Task 8): loaded at the staged version, once, on its chain;
    // what could change during the wait is noted first
    const pack = PACK.exec(name);
    const sessionPacks = require('./session-packs');
    const lockChanges = require('./settings-confirm').lockChangesOf(session);
    const ownBefore = pack != null ? sessionSettings.packOverridesOf(session).get(pack[1]) : undefined;
    // a pack's confirm is a join from before its load to its override: no
    // last-out unload is asked meanwhile (the #341 deep review, 2). One that
    // fails asks the unload itself once its join has ended, loaded here or
    // not (a load-pack with no answer may still land).
    if (pack != null) sessionPacks.joinStart(pack[1]);
    let applied = false;
    try {
      const out = await confirmPackOrCap();
      applied = true;
      return out;
    } finally {
      if (pack != null) {
        sessionPacks.joinEnd(pack[1]);
        if (!applied) sessionPacks.unloadIfUnused(pack[1], {loadedOrNot: true}).catch(() => {});
      }
    }
    async function confirmPackOrCap() {
    if (pack != null) {
      const loaded = await sessionPacks.loadFor(pack[1], staged.version, {ask: ask});
      if (loaded.ok !== true) {
        const problem = loaded.code === 'PACK_OTHER_VERSION' ? 'the pack is loaded at another version' : String(loaded.code || 'CONTROL_FAILED');
        throw notApplied(CountinghouseError.withFields('SETTING_NOT_APPLIED', {name: name, problem: problem.slice(0, 80)}));
      }
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
      if (pack != null) {
        // a lock or latch that fell and lifted, the session's own override,
        // and the loaded version, each as before the wait. A lock here is
        // another kind's (the pack's own was caught above): the refusal
        // claims no decline of the pack (the reviewer's ruling (c))
        if (require('./settings-confirm').lockChangesOf(session) !== lockChanges) {
          return {line: 'not applied (locked in this session)', error: CountinghouseError.withFields('SETTING_LOCKED_THIS_SESSION', {name: name, command: commandFor(name, next)})};
        }
        if (sessionSettings.packOverridesOf(session).get(pack[1]) !== ownBefore) {
          return {line: 'not applied (changed meanwhile)', error: CountinghouseError.withFields('SETTING_CHANGED_MEANWHILE', {name: name})};
        }
        if (sessionPacks.loadedVersion(pack[1]) !== staged.version) {
          return {line: 'not applied (the pack is loaded at another version)', error: CountinghouseError.withFields('SETTING_NOT_APPLIED', {name: name, problem: 'the pack is loaded at another version'})};
        }
      }
      return null;
    })();
    if (stale != null) {
      appendLine({by: by, setting: name, asked: next, change: stale.line, session: session});
      if (stale.tell !== false) tellUser(`${name} not changed: the change you confirmed was not applied (${stale.line.replace(/^not applied \(|\)$/g, '')})`);
      throw stale.error;
    }
    // the session's override: a loosening confirmed over the default in force
    // (a pack's: the version confirmed)
    try {
      sessionSettings.set(session, name, next, pack != null ? {loosening: true, version: staged.version} : {loosening: true, over: options[name]});
    } catch (err) {
      throw notApplied(err);
    }
    if (pack != null) tellUser(`${pack[1]} ${staged.version} turned on for this session (confirmed in ${staged.client.name})`);
    else tellUser(`${name} raised from ${cliValue(name, staged.old)} to ${cliValue(name, next)} for this session (confirmed in ${staged.client.name})`);
    return {name: name, old: staged.old, new: next, applies: 'this session'};
    }
  }

  // A change one session asks for ALL sessions (B2 Task 5b; maintainer's
  // decision, 2026-11-14): the two caps only. It is a global change, as a terminal
  // change is. Judged against the default in force (what every session
  // runs under), never the asking session's own value.
  // - At or under it: no form. It is written to settings.json as the
  //   terminal's set writes it, applied at once (the option, every session's
  //   looser override dropped, calls under way re-armed, the workers told),
  //   and the other sessions are told. One exception to the write: it never
  //   raises what the file yields (a runtime started above it by a flag, or
  //   a tighter value stored for the next start); such a value applies to
  //   every session until the runtime restarts.
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
      if ((sessionChanges.get(session) || 0) >= MAX_SESSION_CHANGES) {
        refuseAsked(name, next, by, `refused, terminal only (${MAX_SESSION_CHANGES} changes made in this session)`, session, SCOPE);
        throw terminalOnly();
      }
      if (next > inForce) {
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
      // the file yields; one the file yields already needs no write.
      const kept = next <= yields;
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
        writeCounts(historyFile);
        try { appendLine(line, true); } catch (err) { fs.rmSync(tmp, {force: true}); throw err; }
        try {
          fs.renameSync(tmp, file);
        } catch (err) {
          fs.rmSync(tmp, {force: true});
          appendLine({by: by, setting: name, change: 'all sessions: not made', problem: err.code || 'error', session: session});
          throw fileInvalid(`it cannot be replaced (${err.code || 'error'})`);
        }
      } else {
        writeCounts(historyFile);
        appendLine(line, true);
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
    if (PACK.test(name)) { if (next === true) packsThisStart.add(name); else packsThisStart.delete(name); }
    if (!PACK.test(name)) tellUser(`${name} raised from ${cliValue(name, staged.old)} to ${cliValue(name, next)} for this start (confirmed in ${staged.client.name})`);
    else { try { LOG.I(`countinghouse_settings: ${name} turned ${next === true ? 'on' : 'off'} for this start (confirmed in ${staged.client.name})`); } catch (err) { /* not serving */ } }
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
  function refuseAsked(name, next, by, change, session = null, scope = null) {
    // a reason (some from outside: ch-local's) one plain line, cut
    change = String(change).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').slice(0, 120);
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
    const kind = `${session != null ? session : ''}\0${kindOf(name)}\0${String(change).replace(/ \(.*$/, '')}\0${scope != null ? scope : ''}`;
    // its session is the line's and its counts' (writeCounts)
    checkPath(session != null ? {session: session} : {});
    const p = pending.get(kind);
    if (p != null) { p.count += 1; return false; }
    appendHistoryLine(historyFile, Object.assign({by: by, setting: name, asked: next, change: change}, session != null ? {session: session} : {}, scoped(scope)));
    pending.set(kind, {setting: kindOf(name) === 'pack' ? 'pack' : name, by: by, change: change, count: 1, written: 1, session: session, scope: scope});
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
const {LIVE_FIELDS, LOCALES, applyLiveOptions} = require('./live-options');
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
    case 'locale':
      if (!LOCALES.includes(value)) return {ok: false, code: 'SETTING_OUT_OF_BOUNDS'};
      options.locale = value;
      return {ok: true};
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
function resetForTests() { atStart = null; started = null; ceilingCache = null; packsThisStart.clear(); sessionChanges.clear(); }
function ceilingForControl(fn) { controlCeiling = fn; }
// The operator's ceiling as the control channel's backstops read it (cached
// until its file or a directory above it changes): packs in place checks its
// packs allowlist at load and reload (lib/modules-in-place.js).
function controlCeilingNow() { return controlCeiling(); }

module.exports = {readFile, PACK, PACK_NAME, create, cachedCeiling, applyConfirmed, captureAtStart, setLiveModules, packUnloaded, applyControlSet, liveOptions, broadcastLiveOptions, applyLiveOptions, resetForTests, ceilingForControl, controlCeilingNow, ALLOWLIST, INPUT_SCHEMA,
  forgetSession, primeCeiling, watchCeiling, recordReplayed, recordUnanswered, inSessionPath, appendHistoryLine};
