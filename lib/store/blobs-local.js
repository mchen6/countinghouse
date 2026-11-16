'use strict';
// The blobs part under --store local (lib/store/blobs.js has the interface).
// Files, because the local kv is one JSON file rewritten whole every 5 s,
// which megabytes of base64 would make unusable; and files survive a restart,
// which a resumed session on the shared runtime needs.
//
// <storePath>/resources/ (0700), two files per item, named by its id:
// <id>.bin (the bytes) and <id>.json (the meta), each 0600 (on Windows the
// owner-only DACL, lib/win-acl.js createPrivate). Each is written to a
// temporary name in the same directory, fsynced and renamed, the bytes before
// the meta, so a meta never names bytes that are not there; a crash between
// them leaves a stray .bin or temporary file, which the sweep removes. The
// directory is refused under the module data path, where the fs broker could
// let a module reach it.
//
// The index (owner, session, bytes, expiresAt per id) and the counters are in
// memory, rebuilt from the meta files when the store opens. Every put checks
// and charges the limits under one mutex, so two writers in this process can
// never both fit where one does. The local store is one process per
// storePath (the runtime it belongs to). The sweep runs at open and every
// SWEEP_MS, unref'd.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {readable, isId, prepare, full, SWEEP_MS} = require('./blobs');

const WINDOWS = process.platform === 'win32';

function under(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function realOrResolved(p) {
  try { return fs.realpathSync.native(p); } catch (e) { return path.resolve(p); }
}

// A private file written whole, atomically: a temporary name, fsynced, then
// renamed to `file`.
function writePrivate(dir, file, data) {
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString('hex')}-${path.basename(file)}`);
  if (WINDOWS) {
    require('../win-acl').createPrivate(tmp, data);
  } else {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.renameSync(tmp, file);
}
function syncDir(dir) {
  if (WINDOWS) return;
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch (e) { /* best effort */ } finally { if (fd != null) fs.closeSync(fd); }
}

function create({storePath, moduleDataPath, limits, now = Date.now}) {
  if (typeof(storePath) !== 'string') throw new Error('blobs: --store local needs a storePath');
  const dir = path.join(path.resolve(storePath), 'resources');
  if (moduleDataPath != null && under(realOrResolved(dir), realOrResolved(moduleDataPath))) {
    throw new Error(`blobs: ${dir} is under the module data path (${moduleDataPath}), where a module could reach it; set --storePath outside it`);
  }
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if (!WINDOWS) fs.chmodSync(dir, 0o700);

  const index = new Map(); // id -> {owner, session, bytes, expiresAt}
  const owners = new Map(); // owner -> {bytes, items}
  let used = 0;
  const charge = (id, e, sign) => {
    const o = owners.get(e.owner) || {bytes: 0, items: 0};
    o.bytes += sign * e.bytes;
    o.items += sign;
    if (o.items <= 0) owners.delete(e.owner); else owners.set(e.owner, o);
    used += sign * e.bytes;
    if (sign > 0) index.set(id, e); else index.delete(id);
  };
  const files = (id) => ({bin: path.join(dir, `${id}.bin`), json: path.join(dir, `${id}.json`)});
  const unlinkQuiet = (f) => { try { fs.unlinkSync(f); } catch (e) { /* gone */ } };
  const drop = (id) => {
    const e = index.get(id);
    if (e != null) charge(id, e, -1);
    const f = files(id);
    unlinkQuiet(f.json); // the meta first: no meta ever names missing bytes
    unlinkQuiet(f.bin);
  };
  const pruneExpired = () => {
    let n = 0;
    const t = now();
    for (const [id, e] of index) if (t >= e.expiresAt) { drop(id); n += 1; }
    return n;
  };

  // the index from the meta files; strays (bytes without a meta, temporary
  // files, anything not ours) removed
  const metas = new Set();
  for (const f of fs.readdirSync(dir)) {
    const m = /^([A-Za-z0-9_-]{43})\.json$/.exec(f);
    if (m == null) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (meta.id !== m[1] || !fs.existsSync(files(m[1]).bin)) throw new Error('incomplete');
      charge(m[1], {owner: meta.owner, session: meta.session, bytes: meta.bytes, expiresAt: meta.expiresAt}, +1);
      metas.add(m[1]);
    } catch (e) {
      unlinkQuiet(path.join(dir, f));
    }
  }
  for (const f of fs.readdirSync(dir)) {
    const m = /^([A-Za-z0-9_-]{43})\.(bin|json)$/.exec(f);
    if (m == null || !metas.has(m[1])) unlinkQuiet(path.join(dir, f));
  }
  pruneExpired();

  // one mutex: every put, remove and sweep in turn
  let chain = Promise.resolve();
  const locked = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
  const timer = setInterval(() => { locked(pruneExpired).catch(() => {}); }, SWEEP_MS);
  if (typeof(timer.unref) === 'function') timer.unref();

  return {
    put: (item) => locked(() => {
      const meta = prepare(item, limits, now);
      pruneExpired();
      const o = owners.get(meta.owner) || {bytes: 0, items: 0};
      if (o.bytes + meta.bytes > limits.quotaBytes) throw full('resourceQuotaBytes');
      if (o.items + 1 > limits.quotaItems) throw full('resourceQuotaItems');
      if (used + meta.bytes > limits.storeBytes) throw full('resourceStoreBytes');
      const f = files(meta.id);
      writePrivate(dir, f.bin, item.bytes);
      writePrivate(dir, f.json, JSON.stringify(meta));
      syncDir(dir);
      charge(meta.id, {owner: meta.owner, session: meta.session, bytes: meta.bytes, expiresAt: meta.expiresAt}, +1);
      return {id: meta.id, expiresAt: meta.expiresAt};
    }),
    async get(id, who = {}) {
      if (!isId(id) || !index.has(id)) return null;
      const f = files(id);
      let meta;
      try { meta = JSON.parse(fs.readFileSync(f.json, 'utf8')); } catch (e) { return null; }
      if (!readable(meta, who, now)) return null;
      let bytes;
      try { bytes = fs.readFileSync(f.bin); } catch (e) { return null; }
      if (bytes.length !== meta.bytes) return null;
      return {meta, bytes};
    },
    remove: (id) => locked(() => { if (isId(id)) drop(id); }),
    sweep: () => locked(pruneExpired),
    async usage(owner = null) {
      if (owner != null) {
        const o = owners.get(owner) || {bytes: 0, items: 0};
        return {bytes: o.bytes, items: o.items};
      }
      return {bytes: used, items: index.size};
    },
    clear: () => locked(() => { for (const id of [...index.keys()]) drop(id); }),
    close: async () => { clearInterval(timer); await chain; }
  };
}

module.exports = {create};
