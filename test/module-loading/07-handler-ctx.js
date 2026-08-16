// Step B-3: the ctx a 6.0.0 handler receives, and specifically that
// ctx.caller carries the *authenticated* caller's identity.
//
// The end-to-end half runs in --workerThread, which is the default mode and
// the one where this was previously impossible: lib/device-manager.js deleted
// args.ctx before the worker boundary, because a Session (req/res, timers,
// bound functions) cannot be structured-cloned. Handlers therefore ran with no
// idea who was calling. Sending the plain identity instead of the Session is
// what fixes that, so the assertion has to run in worker mode to mean
// anything -- single-thread mode would pass either way.
const assert = require('assert');
const http   = require('http');
const exec   = require('child_process').exec;

const handlerCtx = require('../../lib/handler-ctx');

const PORT = 9590;

describe('handler-ctx: identity extraction', () => {
  it('reads a Session (main thread) and a forwarded identity the same way', () => {
    const fromSession = handlerCtx.callerIdentityOf(
      {appKey: 'k1', username: 'alice', isAdmin: true});
    assert.deepStrictEqual(fromSession, {apiKey: 'k1', userName: 'alice', isAdmin: true});

    const fromWire = handlerCtx.callerIdentityOf(
      handlerCtx.wireIdentityOf({appKey: 'k1', username: 'alice', isAdmin: true}));
    assert.deepStrictEqual(fromWire, fromSession, 'both sides of the boundary agree');
  });

  it('reports an unresolved caller as null rather than inventing one', () => {
    assert.deepStrictEqual(handlerCtx.callerIdentityOf(null),
      {apiKey: null, userName: null, isAdmin: false});
    // a bare callback is what the worker re-entry passes as `session`
    assert.deepStrictEqual(handlerCtx.callerIdentityOf(() => {}),
      {apiKey: null, userName: null, isAdmin: false});
  });

  it('the wire form is structured-cloneable, which the Session was not', () => {
    const wire = handlerCtx.wireIdentityOf({appKey: 'k', username: 'u', isAdmin: false,
                                            req: {}, res: {}, timer: setTimeout(() => {}, 0),
                                            callback: () => {}});
    assert.deepStrictEqual(wire, {appKey: 'k', username: 'u', isAdmin: false});
    // the real check: this is what crossing the boundary actually does
    assert.deepStrictEqual(structuredClone(wire), wire);
  });

  it('keeps appKey naming on the wire so createServiceClient({ctx}) still works', () => {
    // CHUtil.createServiceClient reads opts.ctx.appKey
    assert.strictEqual(handlerCtx.wireIdentityOf({appKey: 'k'}).appKey, 'k');
  });
});

function rpc(body, cb) {
  const payload = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
    headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
              'X-CH-Key': 'aabbcc'}
  }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      try { return cb(null, JSON.parse(data)); } catch (e) { return cb(e); }
    });
  });
  req.on('error', cb);
  req.end(payload);
}

describe('handler-ctx: ctx.caller reaches a handler running in a worker', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    console.log('starting countinghouse in --workerThread mode for ctx.caller...');
    exec(`NODE_PATH=./lib node ./framework.js --debug --workerThread` +
         ` --bindAddr 127.0.0.1 --port ${PORT} --debugKey aabbcc` +
         ` --loadModule ./test/fixtures/handler-map-module` +
         ` --loadModule ./test/fixtures/handler-map-convention` +
         ` > /dev/null 2>&1`, () => {});
    setTimeout(done, 14000);
  });

  after((done) => {
    exec(`pkill -f "[f]ramework.js.*--port ${PORT}"`, () => { setTimeout(done, 1000); });
  });

  it('a callback handler sees the authenticated apiKey, not null', (done) => {
    rpc({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'handler_map_module_greetservice_hello', arguments: {name: 'w'}}}, (err, res) => {
      if (err) return done(err);
      assert.strictEqual(res.result.isError, false, JSON.stringify(res.result));
      assert.deepStrictEqual(res.result.structuredContent,
        {output: {text: 'hello w', caller: 'aabbcc'}});
      return done();
    });
  });

  it('an async handler sees it too, through the same wrapper', (done) => {
    rpc({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'handler_map_convention_greetservice_hello', arguments: {name: 'c'}}}, (err, res) => {
      if (err) return done(err);
      assert.strictEqual(res.result.isError, false, JSON.stringify(res.result));
      assert.deepStrictEqual(res.result.structuredContent,
        {output: {text: 'hello c', caller: 'aabbcc'}});
      return done();
    });
  });
});
