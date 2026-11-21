'use strict';
// The top-level modules ch-local held back, and why (B-firstrun: the
// first-run design, (b); the shape agreed with ch-local, 2026-11-20). ch-local's
// start (or its daemon, for a shared runtime) writes the file --heldBackFile
// names, 0600 in its run directory, and rewrites it on every change, then
// asks for it again with the control message {type: 'reread', what:
// 'held-back'}. countinghouse_overview (lib/overview.js) reads it to say,
// in fixed runtime text, why a pack is not loaded and, for a missing
// credential, the command the user runs in their own terminal.
//
//   {"v": 1,
//    "modules": [{"name": "<package>", "reason": "credential" | "off" |
//                 "ceiling" | "missing" | "pin" | "withdrawn" | "stopped" |
//                 "restart" | "calls" | an own module's "changed" |
//                 "sandbox" | "collision" | "refused",
//                 "code"?: <on refused only, required: the runtime's code
//                           for its refusal, [A-Z][A-Z0-9_]{0,63}>,
//                 "root"?: <on calls only, what blocks the part: a reason
//                           but calls, or "not-installed">,
//                 "via"?: "<package>" (the part at the chain's bottom, or
//                          for not-installed the callee's declared name,
//                          a call address's module part: never shown;
//                          required with root)}],
//    "launcher"?: "<home>/bin/ch-local.js"}
//
// Package names only, each by the npm rule (lib/remote/credentials.js
// isPackage) and none starting as an option or a home would (- or ~), at
// most MAX_MODULES, none twice; never a credential, a variable, an origin
// or a path, save the launcher. The file is judged as ch-local's other
// private files are (lib/private-file.js: a regular file under one name,
// never a link, this user's alone) and must be this user's own. A file that
// is not all that is refused whole and the list is empty (logged): never
// "all ready", and the overview then says only that a pack is not loaded.
// The launcher is used only if its real path (the kernel's) is exactly the
// home's own bin/ch-local.js and safe in a quoted command, so the file can
// never make the overview recommend running another script; any other is
// dropped alone (logged), and the overview shows the bare ch-local command.
// It grants nothing: what it can do is add fixed lines to the overview.
// Only with --settingsFile (the single-identity profile: framework.js
// refuses it elsewhere).
const fs = require('fs');
const path = require('path');
const options = require('./cli-options');
const LOG = require('./logger');

// (ceiling: the operator's settings ceiling forbids it -- not the user's
// on/off; not-installed: a callee nothing installed; ch-local's
// availability, 2026-11-20. stopped: the runtime stopped it for good, kept
// out until its version changes; restart: its load waits for the client's
// restart -- ch-local's applier, 2026-11-20; reasons, never roots. An own
// module's (the own-modules design §2.2, B-own-runtime): changed, its files
// changed since the user's yes; sandbox, the sandbox is not enforced;
// collision, another module uses its name -- via names that module;
// refused, this release's runtime refuses to load it, its code with it: the
// feature audit, F9)
const REASONS = ['credential', 'off', 'ceiling', 'missing', 'pin', 'withdrawn', 'stopped', 'restart', 'changed', 'sandbox', 'collision', 'refused', 'calls'];
const NOT_ROOTS = ['calls', 'stopped', 'restart', 'changed', 'sandbox', 'collision', 'refused'];
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ROOTS = [...REASONS.filter((r) => !NOT_ROOTS.includes(r)), 'not-installed'];
// a callee as a module declares it: a call address's module part
// (lib/call-address.js parseAddress: no / or .), a friendlyName (at most 64,
// spec/schema.json), no control character
const isCalleeName = (n) => typeof(n) === 'string' && n.length >= 1 && n.length <= 64 && !/[/.\u0000-\u001f\u007f]/.test(n);
const MAX_MODULES = 256;
const MAX_FILE_BYTES = 64 * 1024;
const LAUNCHER_TAIL = path.join('bin', 'ch-local.js');
const isPackage = (n) => require('./remote/credentials').isPackage(n);
const isObj = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const EMPTY = Object.freeze({modules: new Map(), launcher: null});

// The settings file's home: the directory it is in, by its real path
function homeOf(settingsFile) {
  return fs.realpathSync.native(path.dirname(settingsFile));
}

// A path the overview may quote in a command for the user's own terminal,
// inside double quotes: nothing a shell or cmd would read there ($, `, \
// and ! in a POSIX shell; %, ^ and ! in cmd), no double quote, no control
// character (the medium on B-firstrun, 4; a single quote is plain there:
// the high review of #490, 6), nor the typographic quotes U+2018-U+201F,
// which PowerShell reads as quotes (round 2, 4). On Windows a backslash is
// the separator, read by neither cmd nor PowerShell inside double quotes,
// so it passes there (and only there). Nor a character that changes how a
// command is shown -- C1 controls, the bidirectional marks and isolates,
// line and paragraph separators, the zero-width ones, the soft hyphen and
// the Arabic letter mark -- so the command the user reads is the one they
// run (the medium on B-own-runtime, 8; the reviewer's high, round 1).
const UNSAFE_IN_COMMAND = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c"`$\\%!^\u2018-\u201f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/;
const safeInCommand = (p, platform = process.platform) => !UNSAFE_IN_COMMAND.test(platform === 'win32' ? p.replace(/\\/g, '/') : p);
// the launcher as the file gives it, if it is the home's own: its real path
// is exactly the real path of <home>/bin/ch-local.js (not any bin/ch-local.js
// under the home: the high review of #490, 2), safe in a quoted command ->
// that real path, else null (the list still used: only the launcher is
// dropped, and the command shown is the bare one)
function launcherOf(value, settingsFile) {
  if (typeof(value) !== 'string' || value.length > 4096 || !path.isAbsolute(value)) return null;
  try {
    const own = fs.realpathSync.native(path.join(homeOf(settingsFile), LAUNCHER_TAIL));
    const real = fs.realpathSync.native(value);
    return (real === own && safeInCommand(real)) ? real : null;
  } catch (e) {
    return null;
  }
}
// a package name a command line may carry: the npm rule, and never starting
// as an option or a home directory would (the high review of #490, 7)
const isCommandPackage = (n) => isPackage(n) && !/^[-~]/.test(n);

// text -> {modules: Map(name -> {reason, root, via}), launcher} -- or
// throws, the whole refused (why: the problem, never the file's content)
function parse(text, settingsFile) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error('it is not JSON'); }
  if (!isObj(doc) || doc.v !== 1 || !Array.isArray(doc.modules)) throw new Error('it is not {"v": 1, "modules": [...]}');
  if (doc.modules.length > MAX_MODULES) throw new Error(`it names more than ${MAX_MODULES} modules`);
  for (const k of Object.keys(doc)) if (!['v', 'modules', 'launcher'].includes(k)) throw new Error(`it has a field this runtime does not read (${k.slice(0, 40)})`);
  const modules = new Map();
  for (const m of doc.modules) {
    if (!isObj(m) || !isCommandPackage(m.name)) throw new Error('a module is not named by its package name');
    if (modules.has(m.name)) throw new Error('a module is named twice');
    if (!REASONS.includes(m.reason)) throw new Error('a module\'s reason is not one this runtime knows');
    for (const k of Object.keys(m)) if (!['name', 'reason', 'root', 'via', 'code'].includes(k)) throw new Error('a module has a field this runtime does not read');
    if ((m.reason === 'refused') !== (m.code !== undefined) || (m.code !== undefined && !(typeof(m.code) === 'string' && CODE.test(m.code)))) {
      throw new Error('a code comes with a refused entry, and only there: the runtime\'s code');
    }
    const root = m.root;
    if (root !== undefined && (m.reason !== 'calls' || !ROOTS.includes(root))) throw new Error('a root is a reason or not-installed, on a calls entry only');
    const viaOk = root === 'not-installed' ? isCalleeName(m.via) : isCommandPackage(m.via);
    // via: exactly with a root (calls), or on a collision (the other module)
    const wantsVia = root !== undefined || m.reason === 'collision';
    if (wantsVia !== (m.via !== undefined) || (m.via !== undefined && !viaOk)) {
      throw new Error('via comes with a root (the part\'s package name, or a callee\'s declared name for not-installed) or a collision (the other module\'s package name), and with nothing else');
    }
    modules.set(m.name, Object.assign({reason: m.reason, root: root !== undefined ? root : null, via: m.via !== undefined ? m.via : null}, m.code !== undefined ? {code: m.code} : {}));
  }
  // (a launcher that is not the home's own is dropped, the list kept)
  const launcher = doc.launcher === undefined ? null : launcherOf(doc.launcher, settingsFile);
  if (doc.launcher !== undefined && launcher == null) {
    try { LOG.W('held-back modules: the launcher named is not this home\'s bin/ch-local.js; the overview shows the bare ch-local command'); } catch (_) { /* no logger */ }
  }
  return {modules, launcher};
}

let current = null;   // the list as last read; null: not read yet
let pending = null;   // the read in flight (a Promise of readNow's answer), or null
let queued = null;    // the one read asked while one is in flight, or null
// On Windows the file's ACL is read by a PowerShell run (1 to 10 s): ahead
// of the read, off the main thread (an async child, lib/private-file.js
// aclAhead), and handed to the read, which never runs one on this thread
// (#490's high round 2, 3). A test's may stand in.
const AHEAD = (file) => require('./private-file').aclAhead(file);
let aclAhead = AHEAD;

// the file, read now (ahead: aclAhead's answer, undefined off Windows) ->
// {list, problem, retry}; one that cannot be read is empty (and said once a
// read, its problem named, never its content); retry: only the ACL read
// ahead failed, so the read is worth asking again
function readNow(ahead) {
  const file = options.heldBackFile;
  if (file == null || options.settingsFile == null) return {list: EMPTY, problem: null, retry: false};
  try {
    // as ch-local's other private files are judged (lib/private-file.js:
    // a regular file under one name, never through a link, this user's
    // alone: 0600, or its ACL on Windows, read ahead), and this user's own,
    // judged on the descriptor read (the high review of #490, 2)
    const text = require('./private-file').readChecked(file, {what: 'the held-back list', form: /^\{[\s\S]*\}$/, formText: 'a JSON object',
      maxBytes: MAX_FILE_BYTES, ownOnly: true, ahead, refuse: (message) => new Error(message)}, {settle: false});
    if (text == null) throw Object.assign(new Error('it is not there'), {code: 'ENOENT'});
    return {list: parse(text, options.settingsFile), problem: null, retry: false};
  } catch (e) {
    const problem = e != null && e.code != null ? `it cannot be read (${e.code})` : String(e && e.message);
    try { LOG.W(`held-back modules: --heldBackFile is not used: ${problem}; the overview says only that a pack is not loaded`); } catch (_) { /* no logger */ }
    return {list: EMPTY, problem, retry: e != null && e.aclAhead === true};
  }
}

// one read: its ACL ahead, then the file. The list is replaced only when it
// completes (the previous one kept meanwhile), and not by a read whose ACL
// read ahead failed (the previous list kept; before any, none: the next
// ready() reads again)
async function readOnce() {
  const file = options.heldBackFile;
  let ahead;
  if (file != null && options.settingsFile != null) {
    try { ahead = await aclAhead(file); } catch (e) { ahead = null; }
  }
  const r = readNow(ahead);
  if (!r.retry) current = r.list;
  return r;
}

// a read of the file -> Promise of {list, problem}. One in flight at most,
// and at most one more after it: every read asked meanwhile is that one
// (a burst of rereads costs two reads, and ready() waits for two at most)
function refresh() {
  if (pending == null) {
    const run = readOnce();
    pending = run;
    const done = () => { if (pending === run) pending = null; };
    run.then(done, done);
    return run;
  }
  if (queued == null) {
    const next = pending.catch(() => undefined).then(() => {
      queued = null;
      return refresh();
    });
    queued = next;
  }
  return queued;
}

// at the start (framework.js): the first read begun, off the main thread
function start() {
  if (options.heldBackFile != null && current == null && pending == null) refresh();
}

// -> Promise of the list, once the reads in flight or asked (or the first)
// are done: what countinghouse_overview awaits before it reads list()
function ready() {
  if (queued != null) return queued.then(() => list(), () => list());
  if (pending != null) return pending.then(() => list(), () => list());
  if (current == null && options.heldBackFile != null) return refresh().then(() => list());
  return Promise.resolve(list());
}

// the list as last read (empty before the first read completes: never
// "all ready")
function list() {
  return current != null ? current : EMPTY;
}

// reread {type: 'reread', what: 'held-back'}: its shape checked as every
// reread's is (lib/modules-in-place.js moduleMessageProblem; the shared
// vectors), then the file again. -> Promise of {} (the channel's ok), or
// rejects CONTROL_FAILED with the problem; either way the list is what the
// file now says (empty when it can't be read)
async function reread(msg) {
  const shape = require('./modules-in-place').moduleMessageProblem('reread', msg);
  if (shape != null) throw Object.assign(new Error(shape.message), {code: 'CONTROL_FAILED'});
  if (options.heldBackFile == null) throw Object.assign(new Error('this runtime has no --heldBackFile to read'), {code: 'CONTROL_FAILED'});
  const {problem} = await refresh();
  if (problem != null) throw Object.assign(new Error(`the held-back file is not used: ${problem}`), {code: 'CONTROL_FAILED'});
  return {};
}

// a test's: nothing read yet; aclAheadFn stands in for the ACL read ahead
// (null: the real one)
function resetForTests({aclAheadFn = null} = {}) {
  current = null;
  pending = null;
  queued = null;
  aclAhead = aclAheadFn != null ? aclAheadFn : AHEAD;
}

module.exports = {list, ready, start, reread, parse, resetForTests, safeInCommand, REASONS, ROOTS, MAX_MODULES};
