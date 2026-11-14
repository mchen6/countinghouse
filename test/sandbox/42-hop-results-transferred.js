// Lean worker step 2 (docs/superpowers/specs/2026-11-13-lean-worker-design.md
// section 5, as the reviewer ruled on 2026-11-13): a hop's result crosses the
// main thread as v8.serialize bytes, transferred, never deserialised there.
// It is checked in a validator against the callee's output schema and
// decoded by the calling worker. One cap, --maxOutputBytes, for every
// output: checked in the callee's worker, and on the main thread from the
// bytes' length, which is the guarantee (a module can post through its
// worker's send path).
//
// Port 9749 is sandbox 41's, bound only after 41's server has stopped (one
// mocha process runs the folder's files one after another).
const assert = require('assert');
const crypto = require('crypto');
const path   = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const PORT   = 9749;
const KEY    = 'main-checked-key';
const AUTH   = path.join(__dirname, '41-auth.json');
const CALLEE = path.join(ROOT, 'test', 'fixtures', 'main-checked');
const CALLER = path.join(ROOT, 'test', 'fixtures', 'main-checked-caller');
const CAP    = 64 * 1024 * 1024;

const callerDo = (actionName, input) => post(PORT, KEY, `/devices/${deviceIDForName('main-checked-caller')}/invoke-action`,
  {serviceID: 'urn:countinghouse-test:serviceID:callerService', actionName: actionName, input: input});
const ping = () => callerDo('ping', {});
// answered on the main thread alone: no module's worker takes part
const mainList = () => new Promise((resolve, reject) => request(`http://127.0.0.1:${PORT}`).post('/mcp').set('X-CH-Key', KEY)
  .set('Accept', 'application/json, text/event-stream').send({jsonrpc: '2.0', id: 1, method: 'tools/list'})
  .end((err, res) => (err ? reject(err) : resolve(res))));
const digest = (n, wait) => callerDo('hopDigest', (wait == null) ? {n: n} : {n: n, wait: wait});
const odd = (action, args) => callerDo('hopOdd', {action: action, args: args});
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
// what ctx.call resolves with: the callee's whole reply, {output: ...}
const expected = (n) => { const text = JSON.stringify({output: {s: 'x'.repeat(n)}}); return {length: text.length, sha256: sha256(text)}; };

describe('sandbox 42: a hop\'s result crosses as a transferred buffer', function() {
  this.timeout(180000);
  let server = null;
  before(async () => {
    server = await startServer(PORT, ['--authConfigPath', AUTH, '--loadModule', CALLEE, '--loadModule', CALLER, '--workerThread',
      '--no-directPeerChannels', '--moduleSandbox', 'audit', '--maxOutputBytes', String(CAP), '--validationTimeoutMs', '5000', '--requestTimeout', '60']);
  });
  after(() => stopServer(server));

  it('a 40 MB hop result reaches the calling module intact', async () => {
    const r = await digest(40 * 1024 * 1024);
    assert.deepStrictEqual(r.body.output, expected(40 * 1024 * 1024), `${JSON.stringify(r.body).slice(0, 500)}\n${server.output.slice(-2000)}`);
  });

  it('one just under the cap passes; one over it is refused OUTPUT_TOO_LARGE, naming the callee', async () => {
    const under = CAP - 64;
    assert.deepStrictEqual((await digest(under)).body.output, expected(under));
    const over = await digest(CAP + 1);
    assert.strictEqual(over.body.output.code, 'OUTPUT_TOO_LARGE', JSON.stringify(over.body).slice(0, 500));
    assert.match(over.body.output.message, /^main-checked\/big: its output is \d+ bytes, over the 67108864-byte limit/);
  });

  it('while a 60 MB hop crosses, the main thread keeps answering: tools/list\'s median under 100 ms, none over 1.5 s (unpacking on main would block every one for the unpack)', async () => {
    const big = digest(60 * 1024 * 1024);
    await new Promise((r) => setTimeout(r, 50));
    let worst = 0;
    const times = [];
    let pending = true;
    big.then(() => { pending = false; });
    while (pending) {
      const t = Date.now();
      assert.strictEqual((await mainList()).status, 200);
      worst = Math.max(worst, Date.now() - t);
      times.push(Date.now() - t);
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepStrictEqual((await big).body.output, expected(60 * 1024 * 1024));
    const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
    assert.ok(median < 100, `tools/list's median was ${median} ms over ${times.length} calls`);
    assert.ok(worst < 1500, `a tools/list took ${worst} ms`);
  });

  it('two hops in flight from one caller, 30 MB and 10 MB, each get their own bytes', async () => {
    const [a, b] = await Promise.all([digest(30 * 1024 * 1024), digest(10 * 1024 * 1024)]);
    assert.deepStrictEqual(a.body.output, expected(30 * 1024 * 1024));
    assert.deepStrictEqual(b.body.output, expected(10 * 1024 * 1024));
  });

  it('a Date, Map, Set, typed array, BigInt and nested undefined cross a hop as they did', async () => {
    const r = await odd('odd', {});
    assert.deepStrictEqual(r.body.output, {types: {date: true, map: true, set: true, typed: true, bigint: true, undef: true}}, JSON.stringify(r.body));
  });

  it('an output v8 cannot serialize (a function inside) answers DEVICE_INVOKE_EXCEPTION, as before', async () => {
    const r = await odd('odd', {kind: 'function'});
    assert.strictEqual(r.body.output.code, 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(r.body));
    assert.strictEqual((await ping()).status, 200);
  });

  // the reviewer, 2026-11-13: the callee's worker made the bytes, and under
  // audit a module there can post its own. The caller only ever decodes
  // bytes a validator passed, within the cap.
  describe('a callee that posts hand-made bytes', () => {
    for (const [kind, n, codes] of [
      ['garbage', 0, ['DEVICE_INVOKE_EXCEPTION']],
      ['invalid', 0, ['OUTPUT_DATA_VALIDATION_FAIL']],
      ['deep', 0, ['DEVICE_INVOKE_EXCEPTION', 'VALIDATION_TIMEOUT', 'OUTPUT_DATA_VALIDATION_FAIL']],
      ['huge', CAP + 1, ['OUTPUT_TOO_LARGE']]
    ]) {
      it(`${kind}: the caller's call is refused (${codes.join(' or ')}), and the caller goes on`, async () => {
        const started = Date.now();
        const r = await odd('forge', {kind: kind, n: n});
        assert.ok(codes.includes(r.body.output && r.body.output.code), `${JSON.stringify(r.body).slice(0, 500)}\n${server.output.slice(-2000)}`);
        assert.ok(Date.now() - started < 5000 + 2000, `${Date.now() - started} ms`);
        assert.strictEqual((await ping()).status, 200);
        assert.deepStrictEqual((await odd('odd', {})).body.output.types.date, true, 'the caller still decodes a real result');
      });
    }

    it('bytes forged over the cap are refused from their length on the main thread, never validated', async () => {
      const t = Date.now();
      const r = await odd('forge', {kind: 'huge', n: CAP + 1});
      assert.strictEqual(r.body.output.code, 'OUTPUT_TOO_LARGE', JSON.stringify(r.body).slice(0, 500));
      // the module's own answer was {ok: true}: only the main thread's length check saw these bytes
      assert.match(r.body.output.message, /^main-checked\/forge: its output is \d+ bytes, over the 67108864-byte limit/);
      assert.ok(Date.now() - t < 5000, `${Date.now() - t} ms`);
    });
  });

});

describe('sandbox 42: a hop\'s result that arrives after the caller\'s timeout', function() {
  this.timeout(120000);
  let server = null;
  before(async () => {
    server = await startServer(PORT, ['--authConfigPath', AUTH, '--loadModule', CALLEE, '--loadModule', CALLER, '--workerThread',
      '--no-directPeerChannels', '--maxOutputBytes', String(CAP), '--requestTimeout', '2']);   // seconds
  });
  after(() => stopServer(server));

  it('is dropped: nothing on the main thread throws, and the next hop answers', async () => {
    // the callee answers 20 MB after 3 s; the caller's hop failed at 2 s
    const late = await digest(20 * 1024 * 1024, 3000);
    assert.notDeepStrictEqual(late.body.output, expected(20 * 1024 * 1024), JSON.stringify(late.body).slice(0, 300));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.deepStrictEqual((await digest(1024)).body.output, expected(1024));
    assert.ok(!/TypeError|ReferenceError|uncaught/i.test(server.output), server.output.slice(-2000));
  });
});


// Client calls and errors over the cap, on a server with a small cap: a
// module error of tens of MB reaches the main thread through its log as well
// (the module-to-main channel, #170), which is not what these cases test.
const SMALL = 100000;
describe('sandbox 42: client calls and errors over the cap', function() {
  this.timeout(120000);
  let server = null;
  before(async () => {
    server = await startServer(PORT, ['--authConfigPath', AUTH, '--loadModule', CALLEE, '--loadModule', CALLER, '--workerThread',
      '--no-directPeerChannels', '--moduleSandbox', 'audit', '--maxOutputBytes', String(SMALL)]);
  });
  after(() => stopServer(server));

  // The review of #165 (MED 3): every call whose spec the main thread holds
  // answers in bytes, its error included, and the main thread caps them by
  // their own length. Nothing the module does in its worker gets past it.
  const invoke = (actionName, input) => post(PORT, KEY, `/devices/${deviceIDForName('main-checked')}/invoke-action`,
    {serviceID: 'urn:countinghouse-test:serviceID:checkService', actionName: actionName, input: input});
  describe('a client call over the cap, however the module counts it', () => {
    it('an enumerable getter that makes the output: refused OUTPUT_TOO_LARGE', async () => {
      const r = await invoke('cheat', {kind: 'getter', n: SMALL + 1});
      assert.strictEqual(r.body.code, 'OUTPUT_TOO_LARGE', JSON.stringify(r.body).slice(0, 300));
    });

    it('an error whose message or details are over the cap: refused OUTPUT_TOO_LARGE; a small one crosses as before', async () => {
      for (const kind of ['message', 'details']) {
        const r = await invoke('cheat', {kind: kind, n: SMALL + 1});
        assert.strictEqual(r.body.code, 'OUTPUT_TOO_LARGE', `${kind}: ${JSON.stringify(r.body).slice(0, 300)}`);
      }
      const small = await invoke('cheat', {kind: 'details', n: 10});
      assert.strictEqual(small.body.code, 'CHEAT_DETAILS', JSON.stringify(small.body).slice(0, 300));
    });

    it('a client call\'s output within the cap is answered, unpacked on the main thread after its check', async () => {
      const r = await invoke('cheat', {kind: 'plain'});
      assert.deepStrictEqual([r.status, r.body.output], [200, {s: 'ok'}], JSON.stringify(r.body));
    });

  });

  // last (a describe of its own: mocha runs a describe's own tests before its
  // nested ones): it leaves main-checked's worker with byteLength patched
  describe('last', () => {
    it('the worker\'s own size check fooled (byteLength patched): never answered with the output', async () => {
      const r = await invoke('cheat', {kind: 'byteLength', n: SMALL + 1});
      assert.notStrictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      assert.ok(['OUTPUT_TOO_LARGE', 'DEVICE_INVOKE_EXCEPTION'].includes(r.body.code), JSON.stringify(r.body).slice(0, 300));
    });
  });
});
