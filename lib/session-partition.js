'use strict';
// A per-session module's partitions (shared runtime R1; the design #236,
// section 4a): for each (module, session), its store keys under
// ms:<encoded name>:<session id>: (lib/redis-namespace.js sessionPrefixFor) and
// its files under <moduleDataPath>/<name>/sessions/<session id>/{data,tmp}
// (lib/module-data.js sessionDirsFor). Main thread only.
//
// Their lifetime is the session's (R1 Task 6 calls these):
// - made on the session's first call into the module (ensure);
// - kept while the session can resume, a runtime restart included: removed
//   only when it leaves (bye) or its reconnect window expires (remove), never
//   when the runtime stops;
// - at a start, before the listener accepts, every partition whose session
//   wasn't restored is removed (sweep). One that can't be removed is reported
//   and the sweep goes on: never fatal, so no one session's files can stop a
//   runtime from starting (the review of #353).
//
// Never outside the data path (the review of #353). <name> (and its @scope
// directory) and <name>/sessions must be real directories, not links, as an
// uninstall requires of <name> (MODULE_DATA_NOT_DIRECTORY): remove refuses
// otherwise, and list skips them and reports them. A sessions/<id> that is a
// link or a file is unlinked, never walked; a directory's tree is removed by
// fs.rm, which walks no link inside it, after u+rwx is put back on every
// directory in it (a module can make one 0500 through its broker).
const fs = require('fs');
const path = require('path');
const moduleData = require('./module-data');
const ns = require('./redis-namespace');

const SESSION_ID = /^[0-9a-f]{32}$/;
const key = (name, sessionId) => `${name}\0${sessionId}`;

// -> Promise of {data, tmp}: the session's directories, private (0700)
function ensure(dataRoot, name, sessionId) {
  return moduleData.ensureSessionDirs(dataRoot, name, sessionId);
}

// -> 'missing' | 'directory' | 'other' (a link, a file: never walked)
async function kindOf(p) {
  const st = await fs.promises.lstat(p).catch(() => null);
  if (st == null) return 'missing';
  return (st.isDirectory() && !st.isSymbolicLink()) ? 'directory' : 'other';
}

// The directories a partition's files hang from, each a real directory or
// missing: <@scope>, <name>, <name>/sessions. -> null when they are, or what
// isn't, as a path relative to the data root.
async function notRealAbove(dataRoot, name) {
  const root = moduleData.dirsFor(dataRoot, name).root;
  const chain = (name.startsWith('@') ? [path.dirname(root)] : []).concat([root, path.join(root, 'sessions')]);
  for (const p of chain) {
    const k = await kindOf(p);
    if (k === 'missing') return null;
    if (k === 'other') return path.relative(dataRoot, p);
  }
  return null;
}

// u+rwx put back on every directory in the tree (lstat, never a link), so
// fs.rm can empty it.
async function writableTree(dir) {
  await fs.promises.chmod(dir, 0o700).catch(() => {});
  const entries = await fs.promises.readdir(dir, {withFileTypes: true}).catch(() => []);
  for (const e of entries) if (e.isDirectory()) await writableTree(path.join(dir, e.name));
}

// One partition removed: its name and id checked first (nothing is touched
// for a bad one), the directories above it checked next (refused if one is a
// link), then its keys (a store that can't be reached leaves the files), then
// its files.
// -> Promise of {keys: how many, dirs: whether it had files}
// (an empty sessions/ is left: a new session's ensure may be making its
// partition under it at any time, the start's sweep included)
async function remove(dataRoot, kv, name, sessionId) {
  const prefix = ns.sessionPrefixFor(name, sessionId);
  if (prefix == null) throw new Error('no partition for that module and session');
  const d = moduleData.sessionDirsFor(dataRoot, name, sessionId);   // throws for a name no directory can have
  const bad = await notRealAbove(dataRoot, name);
  if (bad != null) throw new Error(`${bad} is not a directory; the partition's files are not removed through it`);
  const keys = await ns.purgeNamespace(kv, prefix);
  const k = await kindOf(d.root);
  if (k === 'directory') {
    await writableTree(d.root);
    await fs.promises.rm(d.root, {recursive: true, force: true});
  } else if (k === 'other') {
    await fs.promises.unlink(d.root);
  }
  return {keys, dirs: k !== 'missing'};
}

// The module names under the data root that could have partitions: one
// segment, or @scope/name, as module-data's names are; dot-led entries
// (.pins, .validate) are no module's. A link where a <name> or an @scope
// directory would be is skipped and reported (`skipped`).
async function moduleNames(dataRoot, skipped) {
  const entries = await fs.promises.readdir(dataRoot, {withFileTypes: true}).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isSymbolicLink()) { skipped.push({path: e.name, why: 'a link'}); continue; }
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith('@')) { out.push(e.name); continue; }
    const scoped = await fs.promises.readdir(path.join(dataRoot, e.name), {withFileTypes: true}).catch(() => []);
    for (const s of scoped) {
      if (s.name.startsWith('.')) continue;
      if (s.isSymbolicLink()) { skipped.push({path: `${e.name}/${s.name}`, why: 'a link'}); continue; }
      if (s.isDirectory()) out.push(`${e.name}/${s.name}`);
    }
  }
  return out.filter((n) => moduleData.safeName(n));
}

// Whether any partition is there (files or keys): list's walk, stopped at the
// first one found (R1 Task 6: D3's check before listen). -> Promise of boolean
async function any(dataRoot, kv) {
  for (const name of await moduleNames(dataRoot, [])) {
    const sessions = path.join(moduleData.dirsFor(dataRoot, name).root, 'sessions');
    if (await kindOf(sessions) !== 'directory') continue;
    const entries = await fs.promises.readdir(sessions).catch(() => []);
    if (entries.some((n) => SESSION_ID.test(n))) return true;
  }
  let found = false;
  await ns.keysUnder(kv, 'ms:', (k) => {
    const p = ns.partitionOfKey(k);
    if (p != null && moduleData.safeName(p.name)) found = true;
    return found;
  });
  return found;
}

// Every partition present, in the files and in the store, once each, and
// what was skipped because it isn't a real directory.
// -> Promise of {partitions: [{name, sessionId}], skipped: [{path, why}]}
async function list(dataRoot, kv) {
  const found = new Map();
  const skipped = [];
  const add = (name, sessionId) => { if (!found.has(key(name, sessionId))) found.set(key(name, sessionId), {name, sessionId}); };
  for (const name of await moduleNames(dataRoot, skipped)) {
    const sessions = path.join(moduleData.dirsFor(dataRoot, name).root, 'sessions');
    const k = await kindOf(sessions);
    if (k === 'other') { skipped.push({path: path.relative(dataRoot, sessions), why: 'not a directory'}); continue; }
    if (k === 'missing') continue;
    const entries = await fs.promises.readdir(sessions, {withFileTypes: true}).catch(() => []);
    // a link or a file named like a session is a partition too: the sweep unlinks it
    for (const e of entries) if (SESSION_ID.test(e.name)) add(name, e.name);
  }
  await ns.keysUnder(kv, 'ms:', (k) => {
    const p = ns.partitionOfKey(k);
    if (p != null && moduleData.safeName(p.name)) add(p.name, p.sessionId);
  });
  return {partitions: [...found.values()], skipped};
}

// Every partition whose session isn't in `keep` (a Set of the restored ids;
// sweeping all takes an explicit new Set()), removed. One that can't be
// removed is in `failed` and the sweep goes on.
// -> Promise of {removed: [{name, sessionId}], failed: [{name, sessionId, why}], skipped: [{path, why}]}
// opts.onRemoved(p): after each partition's removal (R1 Task 6: its share
// given back then, not at the sweep's end)
async function sweep(dataRoot, kv, keep, opts = {}) {
  // a Set, or anything with has(id) asked as each partition is reached (the
  // start's sweep: restored or open now)
  if (keep == null || typeof(keep.has) !== 'function') throw new TypeError('sweep needs the ids to keep, as a Set (new Set() to sweep every partition)');
  const {partitions, skipped} = await list(dataRoot, kv);
  const removed = [];
  const failed = [];
  for (const p of partitions) {
    if (keep.has(p.sessionId)) continue;
    try {
      await remove(dataRoot, kv, p.name, p.sessionId);
      removed.push(p);
      if (typeof(opts.onRemoved) === 'function') await opts.onRemoved(p);
    } catch (e) {
      failed.push({name: p.name, sessionId: p.sessionId, why: String((e && (e.code || e.message)) || e).slice(0, 200)});
    }
  }
  return {removed, failed, skipped};
}

module.exports = {ensure, remove, list, sweep, any};
