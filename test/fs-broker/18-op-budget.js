// The broker's work per call, counted in libuv pool jobs (async fs calls on
// the main thread) and bridge calls -- machine-independent, unlike the
// benchmarks (docs/benchmarks/sandbox-part2.md). Pins plan 5 Task 4b's
// optimisations: A (no host checks under off), B (writeFile is one call).
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {Quota} = require('../../lib/fs-broker/quota');

const counts = {};
const wrapped = {};
function startCounting() {
  const wrapHandle = (fh) => {
    ['stat', 'read', 'write', 'truncate', 'close'].forEach((k) => {
      const orig = fh[k].bind(fh);
      fh[k] = (...a) => { counts[`fh.${k}`] = (counts[`fh.${k}`] || 0) + 1; return orig(...a); };
    });
    return fh;
  };
  for (const k of ['realpath', 'stat', 'lstat', 'open', 'readlink', 'unlink']) {
    wrapped[k] = fsp[k];
    fsp[k] = (...a) => { counts[k] = (counts[k] || 0) + 1; const r = wrapped[k](...a); return k === 'open' ? r.then(wrapHandle) : r; };
  }
}
function stopCounting() { Object.keys(wrapped).forEach((k) => { fsp[k] = wrapped[k]; }); }
function reset() { Object.keys(counts).forEach((k) => delete counts[k]); }

async function broker(mode) {
  const base = fs.mkdtempSync(path.join(os.homedir(), '.ch-budget-'));
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await ns.prepare();
  const quota = mode === 'off' ? null : new Quota({maxBytes: 1e9, maxEntries: 1e6, enforce: mode === 'enforce', report: () => {}});
  const b = new FsBroker({name: 'm', mode, namespace: ns, cwd: '/app', report: () => {}, quota});
  return {b, done: () => b.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

// One ioBench round as the patch sends it: writeFileSync, readFileSync, statSync, unlinkSync.
async function round(b) {
  const fd = await b.handle('open', ['/data/f', 'w']);
  await b.handle('write', [fd, Buffer.alloc(4096), null]);
  await b.handle('close', [fd]);
  await b.handle('readFile', ['/data/f', 'r']);
  await b.handle('stat', ['/data/f']);
  await b.handle('unlink', ['/data/f']);
}

describe('fs-broker 18: the broker\'s work per call', function() {
  this.timeout(20000);
  before(startCounting);
  after(stopCounting);

  it('off makes no host checks: no realpath or lstat (plan 5 Task 4b, A)', async () => {
    const t = await broker('off');
    try {
      await round(t.b);
      reset();
      await round(t.b);
      assert.strictEqual(counts.realpath || 0, 0, JSON.stringify(counts));
      assert.strictEqual(counts.lstat || 0, 0, JSON.stringify(counts));
    } finally { await t.done(); }
  });

  it('writeFileSync and appendFileSync are one brokered call each (plan 5 Task 4b, B)', async () => {
    const {runBrokered} = require('../helpers/brokered-worker');
    const m = await runBrokered(path.join(__dirname, 'scripts', 'write-once.js'), {mode: 'enforce', countOps: true});
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.strictEqual(m.r, 'hello world');
    assert.deepStrictEqual({writeFile: m.ops.writeFile, open: m.ops.open || 0, write: m.ops.write || 0}, {writeFile: 2, open: 0, write: 0}, JSON.stringify(m.ops));
  });

  it('enforce still checks every path and verifies every open', async () => {
    const t = await broker('enforce');
    try {
      await round(t.b);
      reset();
      await round(t.b);
      assert.ok((counts.realpath || 0) > 0, JSON.stringify(counts));
      assert.ok((counts.readlink || 0) >= 2, 'both opens verified through /proc/self/fd');
    } finally { await t.done(); }
  });
});
