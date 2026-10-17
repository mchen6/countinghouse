// How many libuv pool jobs (async fs calls on the main thread) the broker
// makes for one ioBench round -- writeFileSync (open, write, close),
// readFileSync (readFile), statSync (stat), unlinkSync (unlink) -- in each
// mode. Machine-independent, unlike milliseconds.
//   node perf/fs-broker-ops-count.js
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const counts = {};
const count = (name) => { counts[name] = (counts[name] || 0) + 1; };
const wrapHandle = (fh) => {
  ['stat', 'read', 'write', 'truncate', 'close', 'sync'].forEach((k) => {
    const orig = fh[k].bind(fh);
    fh[k] = (...a) => { count(`fh.${k}`); return orig(...a); };
  });
  return fh;
};
for (const k of ['realpath', 'stat', 'lstat', 'open', 'readlink', 'unlink', 'readdir', 'mkdir', 'access']) {
  const orig = fsp[k];
  fsp[k] = (...a) => { count(k); const r = orig(...a); return k === 'open' ? r.then(wrapHandle) : r; };
}

const {createNamespace} = require('../lib/fs-broker/namespace');
const {FsBroker} = require('../lib/fs-broker/broker');
const {Quota} = require('../lib/fs-broker/quota');

async function round(broker) {
  const fd = await broker.handle('open', ['/data/f', 'w']);
  await broker.handle('write', [fd, Buffer.alloc(4096), null]);
  await broker.handle('close', [fd]);
  await broker.handle('readFile', ['/data/f', 'r']);
  await broker.handle('stat', ['/data/f']);
  await broker.handle('unlink', ['/data/f']);
}

(async () => {
  const out = {};
  for (const mode of ['off', 'audit', 'enforce']) {
    const base = fs.mkdtempSync(path.join(os.homedir(), '.ch-ops-count-'));
    const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
    Object.values(dirs).forEach((d) => fs.mkdirSync(d));
    const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
    await ns.prepare();
    const quota = mode === 'off' ? null : new Quota({maxBytes: 1e9, maxEntries: 1e6, enforce: mode === 'enforce', report: () => {}});
    const broker = new FsBroker({name: 'm', mode, namespace: ns, cwd: '/app', report: () => {}, quota});
    await round(broker);   // warm-up
    Object.keys(counts).forEach((k) => delete counts[k]);
    await round(broker);
    out[mode] = {total: Object.values(counts).reduce((a, b) => a + b, 0), bridgeCalls: 6, byCall: Object.assign({}, counts)};
    await broker.closeAll();
    fs.rmSync(base, {recursive: true, force: true});
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
