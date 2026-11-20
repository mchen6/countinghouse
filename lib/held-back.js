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
//                 "missing" | "pin" | "withdrawn" | "calls",
//                 "root"?: <a reason, on calls only: what blocks the part>,
//                 "via"?: "<package>" (the part, required with root)}],
//    "launcher"?: "<home>/bin/ch-local.js"}
//
// Package names only, each by the npm rule (lib/remote/credentials.js
// isPackage), at most MAX_MODULES, none twice; never a credential, a
// variable, an origin or a path, save the launcher: one absolute path,
// ending in bin/ch-local.js, that resolves (the kernel's real path) inside
// the settings file's home, so the file can never make the overview
// recommend running another script. A file that is not that whole is
// refused whole and the list is empty (logged): never "all ready", and the
// overview then says only that a pack is not loaded. It grants nothing:
// what it can do is add fixed lines to the overview. Only with
// --settingsFile (the single-identity profile: framework.js refuses it
// elsewhere).
const fs = require('fs');
const path = require('path');
const options = require('./cli-options');
const LOG = require('./logger');

const REASONS = ['credential', 'off', 'missing', 'pin', 'withdrawn', 'calls'];
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

// the launcher as the file gives it, if it is the home's own: an absolute
// path ending in bin/ch-local.js, no control character or quote, whose real
// path is inside the home -> the path, else null
function launcherOf(value, settingsFile) {
  if (typeof(value) !== 'string' || value.length > 4096 || !path.isAbsolute(value) || /[\u0000-\u001f\u007f"`]/.test(value)) return null;
  if (!value.endsWith(path.sep + LAUNCHER_TAIL)) return null;
  try {
    const home = homeOf(settingsFile);
    const real = fs.realpathSync.native(value);
    return (real.startsWith(home + path.sep) && real.endsWith(path.sep + LAUNCHER_TAIL)) ? value : null;
  } catch (e) {
    return null;
  }
}

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
    if (!isObj(m) || !isPackage(m.name)) throw new Error('a module is not named by its package name');
    if (modules.has(m.name)) throw new Error('a module is named twice');
    if (!REASONS.includes(m.reason)) throw new Error('a module\'s reason is not one this runtime knows');
    for (const k of Object.keys(m)) if (!['name', 'reason', 'root', 'via'].includes(k)) throw new Error('a module has a field this runtime does not read');
    const root = m.root;
    if (root !== undefined && (m.reason !== 'calls' || !REASONS.includes(root) || root === 'calls')) throw new Error('a root is a reason, on a calls entry only');
    if ((root !== undefined) !== (m.via !== undefined) || (m.via !== undefined && !isPackage(m.via))) throw new Error('a root comes with via, the part\'s package name');
    modules.set(m.name, {reason: m.reason, root: root !== undefined ? root : null, via: m.via !== undefined ? m.via : null});
  }
  const launcher = doc.launcher === undefined ? null : launcherOf(doc.launcher, settingsFile);
  if (doc.launcher !== undefined && launcher == null) throw new Error('its launcher is not the home\'s bin/ch-local.js');
  return {modules, launcher};
}

let current = null;   // the list as last read; null: not read yet
// the file, read now -> the list; one that cannot be read is empty (and
// said once a read, its problem named, never its content)
function readNow() {
  const file = options.heldBackFile;
  if (file == null || options.settingsFile == null) return {list: EMPTY, problem: null};
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error(st.isFile() ? 'it is too large' : 'it is not a file');
    return {list: parse(fs.readFileSync(file, 'utf8'), options.settingsFile), problem: null};
  } catch (e) {
    const problem = e != null && e.code != null ? `it cannot be read (${e.code})` : String(e && e.message);
    try { LOG.W(`held-back modules: --heldBackFile is not used: ${problem}; the overview says only that a pack is not loaded`); } catch (_) { /* no logger */ }
    return {list: EMPTY, problem};
  }
}

// the list (read once, then as the last reread left it)
function list() {
  if (current == null) current = readNow().list;
  return current;
}

// reread {what: 'held-back'}: the file again. -> {} (the channel's ok), or
// throws CONTROL_FAILED with the problem; either way the list is what the
// file now says (empty when it can't be read)
function reread() {
  if (options.heldBackFile == null) throw Object.assign(new Error('this runtime has no --heldBackFile to read'), {code: 'CONTROL_FAILED'});
  const {list: l, problem} = readNow();
  current = l;
  if (problem != null) throw Object.assign(new Error(`the held-back file is not used: ${problem}`), {code: 'CONTROL_FAILED'});
  return {};
}

// a test's: read again at the next list()
function resetForTests() { current = null; }

module.exports = {list, reread, parse, resetForTests, REASONS, MAX_MODULES};
