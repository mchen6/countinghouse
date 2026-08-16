// Step C: how a handler reports failure, and how the runtime decides whether
// a handler is callback-style or promise-style.
//
// Design section 4 asked for async-throw, promise-reject and callback-err to
// produce identical responses. They are identical for every error the runtime
// can *classify*, and deliberately not identical for the rest -- see
// docs/design-decisions.md, "Handler failure is classified by the error, not
// by how it arrived". The matrix below is that decision, asserted:
//
//   callback(new DeviceError(C))  ->  C                          }  the same
//   throw   new DeviceError(C)    ->  C                          }  either way
//   callback(new Error('boom'))   ->  DEVICE_INVOKE_FAIL          (reported)
//   throw   new Error('boom')     ->  DEVICE_INVOKE_EXCEPTION     (crashed)
//
// The first pair is the part that was broken: a rejection used to be flattened
// to DEVICE_INVOKE_EXCEPTION unconditionally, so an async handler had no way
// to return a typed error at all. Nothing covered it, because no bundled
// module throws a typed error (echo-device-module's testErrorInfoAsync throws
// plain Errors, and no test even referenced it).
const assert = require('assert');
const http   = require('http');
const exec   = require('child_process').exec;

const PORT = 9595;

function rpc(tool, cb) {
  const payload = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call',
                                  params: {name: tool, arguments: {}}});
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
    headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
              'X-CH-Key': 'aabbcc'}
  }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      try { return cb(null, JSON.parse(data).result); } catch (e) { return cb(e); }
    });
  });
  req.on('error', cb);
  req.end(payload);
}

function call(action, cb) {
  return rpc(`error_semantics_module_errservice_${action.toLowerCase()}`, cb);
}

describe('module-loading 08: handler failure classification and style detection', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    console.log('starting countinghouse for the error-semantics matrix...');
    exec(`NODE_PATH=./lib node ./framework.js --debug --bindAddr 127.0.0.1 --port ${PORT
         } --debugKey aabbcc --loadModule ./test/fixtures/error-semantics-module` +
         ` > /dev/null 2>&1`, () => {});
    setTimeout(done, 13000);
  });

  after((done) => {
    exec(`pkill -f "[f]ramework.js.*--port ${PORT}"`, () => { setTimeout(done, 1000); });
  });

  it('a typed error keeps its code when reported through a callback', (done) => {
    call('callbackTyped', (err, result) => {
      if (err) return done(err);
      assert.strictEqual(result.isError, true, JSON.stringify(result));
      assert.strictEqual(result.structuredContent.code, 'DEVICE_OFFLINE');
      return done();
    });
  });

  it('a typed error keeps the SAME code when thrown from an async handler', (done) => {
    call('rejectTyped', (err, result) => {
      if (err) return done(err);
      assert.strictEqual(result.isError, true, JSON.stringify(result));
      // the regression this step exists to fix: previously
      // DEVICE_INVOKE_EXCEPTION, with the real code discarded
      assert.strictEqual(result.structuredContent.code, 'DEVICE_OFFLINE',
        'a rejection carrying a typed error must not be flattened');
      return done();
    });
  });

  it('the two styles agree exactly, which is the guarantee being made', (done) => {
    call('callbackTyped', (err, viaCallback) => {
      if (err) return done(err);
      call('rejectTyped', (err2, viaReject) => {
        if (err2) return done(err2);
        assert.deepStrictEqual(viaReject.structuredContent, viaCallback.structuredContent,
          'same failure, two styles, one response');
        return done();
      });
    });
  });

  it('an untyped error reported through a callback is a reported failure', (done) => {
    call('callbackPlain', (err, result) => {
      if (err) return done(err);
      assert.strictEqual(result.isError, true, JSON.stringify(result));
      assert.strictEqual(result.structuredContent.code, 'DEVICE_INVOKE_FAIL');
      return done();
    });
  });

  it('an untyped error thrown is a crash, and stays distinguishable from one', (done) => {
    call('rejectPlain', (err, result) => {
      if (err) return done(err);
      assert.strictEqual(result.isError, true, JSON.stringify(result));
      assert.strictEqual(result.structuredContent.code, 'DEVICE_INVOKE_EXCEPTION',
        'collapsing this into DEVICE_INVOKE_FAIL would erase "the handler crashed"');
      return done();
    });
  });

  it('a plain function returning a promise works (it used to hang)', (done) => {
    // `() => Promise.resolve(...)` has constructor.name === 'Function', so the
    // old AsyncFunction-name check sent it down the callback branch, where
    // nothing ever called back. Style is decided by the returned value now.
    call('promiseFromPlainFn', (err, result) => {
      if (err) return done(err);
      assert.strictEqual(result.isError, false, JSON.stringify(result));
      assert.deepStrictEqual(result.structuredContent, {output: {ok: true}});
      return done();
    });
  });

  it('an ordinary async handler still succeeds', (done) => {
    call('asyncOk', (err, result) => {
      if (err) return done(err);
      assert.strictEqual(result.isError, false, JSON.stringify(result));
      assert.deepStrictEqual(result.structuredContent, {output: {ok: true}});
      return done();
    });
  });
});
