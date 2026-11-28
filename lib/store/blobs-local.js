'use strict';
// The blobs part under --store local (lib/store/blobs.js has the interface).
// Files, because the local kv is one JSON file rewritten whole every 5 s,
// which megabytes of base64 would make unusable; and files survive a restart,
// which a resumed session on the shared runtime needs.
//
// A local store is shared by every process given the same --storePath
// (several stdio launchers, say), so the disk is the truth, never memory:
//   <storePath>/resources/            0700, refused under the module data path
//     <id>.bin   the bytes            } 0600 (on Windows the owner-only DACL,
//     <id>.json  the meta             }   lib/win-acl.js createPrivate)
//     index.json {id: {owner, session, bytes, expiresAt}}: what the limits
//                count, for every process
//     .lockdir/  this directory's own lock, in a folder of its own (not
//                <storePath>/.lock, so a put never holds up the kv or the
//                metering; and not among the items, so taking it never
//                lists them)
//
// get(id) reads <id>.json and <id>.bin directly, so any process reads any
// item; the id is checked to be exactly the form put mints before any path
// is made from it, and each file is opened without following a link and
// must be a regular, owner-only file of this user's. put writes <id>.bin
// first, outside the lock (its id is new and unique); then, under the lock,
// reads the index, prunes expired items, checks the owner's bytes, the
// owner's items and the store's bytes, writes the meta and the index; a
// refusal or a failure removes what it wrote. Every file is written to a
// temporary name, fsynced and renamed. The lock is the store lock's own
// (lib/store/json-file.js tryLock: its takeover, its release, its holders in
// this process), taken without blocking the event loop (retried on a timer,
// to a monotonic deadline), with one difference: a lock is taken over only
// when its holder's process is gone, never a live holder's for its age
// ({liveHolderStale: false}), since a holder here awaits inside its hold and
// a takeover of a live one could lose its writes. A hung holder blocks the
// result store until it ends.
//
// The sweep, under the lock, at open and every SWEEP_MS in each process:
// expired items (the meta first, then the bytes), and strays (a .bin, meta
// or temporary file no index entry names) only when the file's own mtime is
// older than STRAY_MS, so another process's put in progress is never touched.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const {readable, isId, prepare, full, SWEEP_MS} = require('./blobs');

const WINDOWS = process.platform === 'win32';
const STRAY_MS = 10 * 60 * 1000;
const LOCK_RETRY_MS = 10;
const LOCK_WAIT_MS = 5000;
const NAME = /^([A-Za-z0-9_-]{43})\.(bin|json)$/;

const {resourcesDir, resourcesProblem} = require('./resources-path');

const {tryLock, isBusy} = require('./json-file');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One attempt at the directory's lock: a release function, or null (busy).
const lockDirOf = (dir) => path.join(dir, '.lockdir');
async function withLock(dir, fn) {
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (;;) {
    const release = tryLock(lockDirOf(dir), {liveHolderStale: false});
    if (!isBusy(release)) {
      try { return await fn(); } finally { release(); }
    }
    if (performance.now() > deadline) throw new Error(`blobs: the result store's lock ${path.join(lockDirOf(dir), '.lock')} is held by a live process`);
    await sleep(LOCK_RETRY_MS);
  }
}

// A private file written whole, atomically: a temporary name in the same
// directory, fsynced, renamed to `file`.
async function writePrivate(dir, file, data) {
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString('hex')}-${path.basename(file)}`);
  try {
    if (WINDOWS) {
      require('../win-acl').createPrivate(tmp, data);
    } else {
      const fh = await fsp.open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
    }
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

// A file of the store's, read without following a link: a regular file, and
// on POSIX this user's and owner-only. null for anything else.
const NOFOLLOW = (fs.constants.O_NOFOLLOW || 0);
async function readPrivate(file) {
  let fh = null;
  try {
    if (WINDOWS) {
      const st = await fsp.lstat(file);
      if (!st.isFile()) return null;
    }
    fh = await fsp.open(file, fs.constants.O_RDONLY | NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) return null;
    if (!WINDOWS && ((st.mode & 0o077) !== 0 || (typeof(process.geteuid) === 'function' && st.uid !== process.geteuid()))) return null;
    return await fh.readFile();
  } catch (e) {
    return null;
  } finally {
    if (fh != null) await fh.close().catch(() => {});
  }
}

const unlinkQuiet = (f) => fsp.unlink(f).catch(() => {});

function create({storePath, moduleDataPath, limits, now = Date.now}) {
  if (typeof(storePath) !== 'string') throw new Error('blobs: --store local needs a storePath');
  const problem = resourcesProblem(storePath, moduleDataPath);
  if (problem != null) throw new Error(`blobs: ${problem}; set --storePath outside it`);
  const dir = resourcesDir(storePath);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if (!WINDOWS) fs.chmodSync(dir, 0o700);
  const files = (id) => ({bin: path.join(dir, `${id}.bin`), json: path.join(dir, `${id}.json`)});
  const indexFile = path.join(dir, 'index.json');

  // the index, under the lock; rebuilt from the meta files when missing or
  // unreadable
  const readIndex = async () => {
    const raw = await readPrivate(indexFile);
    if (raw != null) {
      try {
        const idx = JSON.parse(raw.toString('utf8'));
        if (idx != null && typeof(idx) === 'object' && !Array.isArray(idx)) return idx;
      } catch (e) { /* rebuilt below */ }
    }
    const idx = {};
    for (const f of await fsp.readdir(dir)) {
      const m = /^([A-Za-z0-9_-]{43})\.json$/.exec(f);
      if (m == null) continue;
      const text = await readPrivate(path.join(dir, f));
      try {
        const meta = JSON.parse(text.toString('utf8'));
        if (meta.id === m[1]) idx[m[1]] = {owner: meta.owner, session: meta.session, bytes: meta.bytes, expiresAt: meta.expiresAt};
      } catch (e) { /* a stray, swept by age */ }
    }
    return idx;
  };
  const writeIndex = (idx) => writePrivate(dir, indexFile, JSON.stringify(idx));
  const dropFiles = async (id) => {
    const f = files(id);
    await unlinkQuiet(f.json); // the meta first: no meta ever names missing bytes
    await unlinkQuiet(f.bin);
  };
  const pruneExpired = async (idx) => {
    let n = 0;
    const t = now();
    for (const id of Object.keys(idx)) {
      if (t >= idx[id].expiresAt) { delete idx[id]; await dropFiles(id); n += 1; }
    }
    return n;
  };
  const totals = (idx, owner) => {
    let bytes = 0;
    let items = 0;
    for (const e of Object.values(idx)) {
      if (owner != null && e.owner !== owner) continue;
      bytes += e.bytes;
      items += 1;
    }
    return {bytes, items};
  };

  const sweep = () => withLock(dir, async () => {
    const idx = await readIndex();
    const removed = await pruneExpired(idx);
    for (const f of await fsp.readdir(dir)) {
      // (the lock's own folder never a stray; anything else unknown ages out)
      if (f === 'index.json' || f === '.lockdir') continue;
      const m = NAME.exec(f);
      if (m != null && Object.hasOwn(idx, m[1])) continue;
      const p = path.join(dir, f);
      try {
        const st = await fsp.lstat(p);
        if (Date.now() - st.mtimeMs > STRAY_MS) await unlinkQuiet(p);
      } catch (e) { /* gone */ }
    }
    await writeIndex(idx);
    return removed;
  });
  const ready = sweep().catch(() => 0);
  const timer = setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS);
  if (typeof(timer.unref) === 'function') timer.unref();

  return {
    ready,
    async put(item) {
      const meta = prepare(item, limits, now);
      const f = files(meta.id);
      await writePrivate(dir, f.bin, item.bytes);
      let charged = false;
      try {
        await withLock(dir, async () => {
          const idx = await readIndex();
          await pruneExpired(idx);
          const o = totals(idx, meta.owner);
          if (o.bytes + meta.bytes > limits.quotaBytes) throw full('resourceQuotaBytes');
          if (o.items + 1 > limits.quotaItems) throw full('resourceQuotaItems');
          if (totals(idx, null).bytes + meta.bytes > limits.storeBytes) throw full('resourceStoreBytes');
          await writePrivate(dir, f.json, JSON.stringify(meta));
          idx[meta.id] = {owner: meta.owner, session: meta.session, bytes: meta.bytes, expiresAt: meta.expiresAt};
          await writeIndex(idx);
          charged = true;
        });
      } finally {
        if (!charged) await dropFiles(meta.id);
      }
      return {id: meta.id, expiresAt: meta.expiresAt};
    },
    async get(id, who = {}) {
      if (!isId(id)) return null;
      const f = files(id);
      const text = await readPrivate(f.json);
      if (text == null) return null;
      let meta;
      try { meta = JSON.parse(text.toString('utf8')); } catch (e) { return null; }
      if (meta == null || meta.id !== id || !readable(meta, who, now)) return null;
      const bytes = await readPrivate(f.bin);
      if (bytes == null || bytes.length !== meta.bytes) return null;
      return {meta, bytes};
    },
    async remove(id) {
      if (!isId(id)) return;
      await withLock(dir, async () => {
        const idx = await readIndex();
        delete idx[id];
        await dropFiles(id);
        await writeIndex(idx);
      });
    },
    sweep,
    async usage(owner = null) {
      return totals(await readIndex(), owner);
    },
    clear: () => withLock(dir, async () => {
      for (const id of Object.keys(await readIndex())) await dropFiles(id);
      await writeIndex({});
    }),
    close: async () => { clearInterval(timer); await ready; }
  };
}

module.exports = {create, STRAY_MS,
  // (its lock, for the store's own tests)
  forTests: {withLock}};
