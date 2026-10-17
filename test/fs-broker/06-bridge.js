const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {Worker, receiveMessageOnPort} = require('worker_threads');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {FsScheduler} = require('../../lib/fs-broker/scheduler');
const {createBridge} = require('../../lib/fs-broker/server');
const {mkdtemp} = require('../helpers/test-tmp');

const CLIENT = path.join(__dirname, '..', '..', 'lib', 'fs-broker', 'client.js');

async function harness(opts) {
  opts = opts || {};
  const base = mkdtemp('bridge-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await ns.prepare();
  const scheduler = opts.scheduler || new FsScheduler({globalCap: 3});
  const key = opts.key || 'w1';
  const broker = new FsBroker({name: 'm', mode: 'audit', namespace: ns, cwd: '/', report: () => {},
    schedule: (fn) => scheduler.submit(key, fn), hooks: opts.hooks});
  const bridge = createBridge({broker, scheduler, key, deadlineMs: opts.deadlineMs, maxStuck: opts.maxStuck});
  return {base, dirs, broker, scheduler, bridge,
    run(body) {
      if (this.worker) throw new Error('one run() per harness: a bridge\'s ports can be transferred once');
      const code = `const {workerData, parentPort} = require('worker_threads');
        const client = require(${JSON.stringify(CLIENT)}).createClient(workerData.t, {backstopMs: workerData.backstop || 35000});
        (async () => { ${body} })().then((r) => parentPort.postMessage({ok: true, r}), (e) => parentPort.postMessage({ok: false, e: {code: e.code, message: e.message, path: e.path}}));`;
      const w = new Worker(code, {eval: true, workerData: {t: bridge.transfer, backstop: opts.backstop}, transferList: bridge.transferList});
      this.worker = w;
      return new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    },
    async done() { if (this.worker) await this.worker.terminate(); await bridge.close(); fs.rmSync(base, {recursive: true, force: true}); }
  };
}

describe('fs-broker 06: the bridge', function() {
  this.timeout(20000);

  it('answers sync and async calls, and rebuilds errors', async () => {
    const h = await harness();
    try {
      fs.writeFileSync(path.join(h.dirs.data, 'a'), 'hello');
      const m = await h.run(`
        const s = client.sync('readFile', ['/data/a', 'r']);
        const a = await client.async('readFile', ['/data/a', 'r']);
        let err = null;
        try { client.sync('stat', ['/data/missing']); } catch (e) { err = {code: e.code, path: e.path, isError: e instanceof Error}; }
        return {s: Buffer.from(s).toString(), a: Buffer.from(a).toString(), err};`);
      assert.deepStrictEqual(m, {ok: true, r: {s: 'hello', a: 'hello', err: {code: 'ENOENT', path: '/data/missing', isError: true}}});
    } finally { await h.done(); }
  });

  it('returns a 16 MB result in one sync call', async () => {
    const h = await harness();
    try {
      fs.writeFileSync(path.join(h.dirs.data, 'big'), Buffer.alloc(16 * 1024 * 1024, 7));
      const m = await h.run(`return Buffer.from(client.sync('readFile', ['/data/big', 'r'])).length;`);
      assert.deepStrictEqual(m, {ok: true, r: 16 * 1024 * 1024});
    } finally { await h.done(); }
  });

  it('a call past the broker deadline gets ETIMEDOUT; the late reply is discarded and the next call in the same worker gets its own', async () => {
    const h = await harness({deadlineMs: 200,
      hooks: {afterCheck: (syscall, host) => (host.endsWith('/slow') ? new Promise((r) => setTimeout(r, 400)) : null)}});
    try {
      fs.writeFileSync(path.join(h.dirs.data, 'ok'), 'fine');
      const m = await h.run(`
        let code = null;
        try { client.sync('stat', ['/data/slow']); } catch (e) { code = e.code; }
        await new Promise((r) => setTimeout(r, 400));   // the slow call's late reply lands meanwhile
        let second;
        try { second = Buffer.from(client.sync('readFile', ['/data/ok', 'r'])).toString(); } catch (e) { second = e.code; }
        return {code, second};`);
      assert.deepStrictEqual(m, {ok: true, r: {code: 'ETIMEDOUT', second: 'fine'}});
    } finally { await h.done(); }
  });

  it('refuses a second sync request while one is in flight (a waiting worker cannot send two)', async () => {
    const h = await harness({hooks: {afterCheck: (syscall, host) => (host.endsWith('/wait') ? new Promise((r) => setTimeout(r, 300)) : null)}});
    try {
      const port = h.bridge.transfer.syncPort;
      port.postMessage({id: 1, op: 'stat', args: ['/data/wait']});
      port.postMessage({id: 2, op: 'stat', args: ['/data']});
      await new Promise((r) => setTimeout(r, 700));
      const got = [];
      let msg;
      while ((msg = receiveMessageOnPort(port)) !== undefined) got.push(msg.message);
      assert.deepStrictEqual(got.find((x) => x.id === 2).error.code, 'EIO', JSON.stringify(got));
      assert.strictEqual(got.find((x) => x.id === 1).error.code, 'ENOENT');
    } finally { await h.done(); }
  });

  it('two stuck operations put the worker on EIO, and do not stop another worker', async () => {
    const scheduler = new FsScheduler({globalCap: 3});
    const h = await harness({scheduler, key: 'stuck', deadlineMs: 100, maxStuck: 2,
      hooks: {afterCheck: (syscall, host) => (host.endsWith('/hang') ? new Promise(() => {}) : null)}});
    const other = await harness({scheduler, key: 'other'});
    try {
      const m = await h.run(`
        const codes = [];
        for (let i = 0; i < 3; i++) { try { await client.async('stat', ['/data/hang']); } catch (e) { codes.push(e.code); } }
        return codes;`);
      assert.deepStrictEqual(m, {ok: true, r: ['ETIMEDOUT', 'ETIMEDOUT', 'EIO']});
      assert.strictEqual(h.bridge.stuck(), 2);
      fs.writeFileSync(path.join(other.dirs.data, 'x'), 'y');
      const o = await other.run(`return Buffer.from(await client.async('readFile', ['/data/x', 'r'])).toString();`);
      assert.deepStrictEqual(o, {ok: true, r: 'y'});
    } finally { await other.done(); await h.done(); }
  });

  it('counts sync calls in flight for the heartbeat', async () => {
    let release;
    const h = await harness({hooks: {afterCheck: (syscall, host) => (host.endsWith('/wait') ? new Promise((r) => { release = r; }) : null)}});
    try {
      const pending = h.run(`try { client.sync('stat', ['/data/wait']); } catch (e) { return e.code; } return 'ok';`);
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(h.bridge.syncInFlight(), 1);
      release();
      await pending;
      assert.strictEqual(h.bridge.syncInFlight(), 0);
    } finally { await h.done(); }
  });

  it('a worker terminated while waiting ends promptly, and close() releases its descriptors', async () => {
    const h = await harness({hooks: {afterCheck: (syscall, host) => (host.endsWith('/forever') ? new Promise(() => {}) : null)}});
    try {
      fs.writeFileSync(path.join(h.dirs.data, 'f'), 'x');
      h.run(`client.sync('open', ['/data/f', 'r']); client.sync('stat', ['/data/forever']);`);
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      await h.worker.terminate();
      assert.ok(Date.now() - t0 < 2000, `terminate took ${Date.now() - t0} ms`);
      h.worker = null;
      await h.bridge.close();
      assert.strictEqual(h.broker.fds.size, 0);
    } finally { await h.done(); }
  });
});
