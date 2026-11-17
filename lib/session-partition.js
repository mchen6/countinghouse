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
//   wasn't restored is removed (sweep).
//
// Removal never follows a link: a sessions/<id> that is a link is unlinked,
// not walked, and fs.rm walks no link inside the tree.
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

// One partition removed, keys first (a store that can't be reached leaves the
// files as they were, as an uninstall's purge does).
// -> Promise of {keys: how many, dirs: whether its directory was there}
async function remove(dataRoot, kv, name, sessionId) {
  const prefix = ns.sessionPrefixFor(name, sessionId);
  if (prefix == null) throw new Error('no partition for that module and session');
  const keys = await ns.purgeNamespace(kv, prefix);
  const d = moduleData.sessionDirsFor(dataRoot, name, sessionId);
  const st = await fs.promises.lstat(d.root).catch(() => null);
  if (st != null) await fs.promises.rm(d.root, {recursive: true, force: true});
  // sessions/ itself once empty, so a module with none leaves none behind
  await fs.promises.rmdir(d.sessions).catch(() => {});
  return {keys, dirs: st != null};
}

// The module names under the data root that could have partitions: one
// segment, or @scope/name, as module-data's names are; dot-led entries
// (.pins, .validate) are no module's.
async function moduleNames(dataRoot) {
  const entries = await fs.promises.readdir(dataRoot, {withFileTypes: true}).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (!e.name.startsWith('@')) { out.push(e.name); continue; }
    const scoped = await fs.promises.readdir(path.join(dataRoot, e.name), {withFileTypes: true}).catch(() => []);
    for (const s of scoped) if (s.isDirectory() && !s.name.startsWith('.')) out.push(`${e.name}/${s.name}`);
  }
  return out.filter((n) => moduleData.safeName(n));
}

// Every partition present, in the files and in the store, once each.
// -> Promise of [{name, sessionId}]
async function list(dataRoot, kv) {
  const found = new Map();
  const add = (name, sessionId) => { if (!found.has(key(name, sessionId))) found.set(key(name, sessionId), {name, sessionId}); };
  for (const name of await moduleNames(dataRoot)) {
    const sessions = path.join(moduleData.dirsFor(dataRoot, name).root, 'sessions');
    const entries = await fs.promises.readdir(sessions, {withFileTypes: true}).catch(() => []);
    // a link named like a session is a partition too, so the sweep unlinks it
    for (const e of entries) if (SESSION_ID.test(e.name) && (e.isDirectory() || e.isSymbolicLink())) add(name, e.name);
  }
  await ns.keysUnder(kv, 'ms:', (k) => {
    const p = ns.partitionOfKey(k);
    if (p != null && moduleData.safeName(p.name)) add(p.name, p.sessionId);
  });
  return [...found.values()];
}

// Every partition whose session isn't in `keep` (the restored ids), removed.
// -> Promise of [{name, sessionId}] removed
async function sweep(dataRoot, kv, keep) {
  const removed = [];
  for (const p of await list(dataRoot, kv)) {
    if (keep != null && keep.has(p.sessionId)) continue;
    await remove(dataRoot, kv, p.name, p.sessionId);
    removed.push(p);
  }
  return removed;
}

module.exports = {ensure, remove, list, sweep};
