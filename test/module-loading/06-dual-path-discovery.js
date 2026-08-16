// Step B-2: discovery is optional, not removed. Two module shapes are
// supported and the framework picks between them by what the module exports;
// this asserts both paths work, in one server, at the same time.
//
//   handler map (plain object) -> one device built from api.json, no discovery
//   class / EventEmitter       -> the existing dynamic path, unchanged
//
// The dynamic half is the part worth testing carefully, because the argument
// for keeping it is a capability claim: a module that decides at runtime how
// many devices to expose, and withdraws one when its backing resource goes
// away. Before this file nothing in the repo emitted 'deviceoffline' at all --
// the capability existed in lib/module-manager.js and lib/device-manager.js
// with no test behind it. If the claim is the reason the path survives 6.0.0,
// it should be demonstrated rather than asserted.
//
// Note on 'deviceoffline' semantics, which this test pins rather than changes:
// DeviceManager.prototype.onDeviceOffline sets `online = false`; it does not
// remove the device. So an offline device is still listed by tools/list and
// fails at call time with DEVICE_OFFLINE. That is the existing behaviour and
// section 3.2 requires it stay unchanged through this refactor.
const assert = require('assert');
const http   = require('http');
const exec   = require('child_process').exec;

const PORT   = 9586;
const DEVICE_COUNT = 3;

function startServer(done) {
  exec(`DYNAMIC_DEVICE_COUNT=${DEVICE_COUNT} NODE_PATH=./lib node ./framework.js --debug` +
       ` --bindAddr 127.0.0.1 --port ${PORT} --debugKey aabbcc` +
       ` --loadModule ./test/fixtures/dynamic-discovery-module` +
       ` --loadModule ./test/fixtures/handler-map-module` +
       ` > /dev/null 2>&1`, () => {});
  setTimeout(done, 14000);
}

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

function toolNames(cb) {
  rpc({jsonrpc: '2.0', id: 1, method: 'tools/list'}, (err, res) => {
    if (err) return cb(err);
    return cb(null, res.result.tools.map((t) => t.name));
  });
}

function call(tool, args, cb) {
  rpc({jsonrpc: '2.0', id: 2, method: 'tools/call',
       params: {name: tool, arguments: args}}, (err, res) => {
    if (err) return cb(err);
    return cb(null, res.result);
  });
}

describe('module-loading 06: both module shapes, in one server', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    console.log('starting countinghouse with one dynamic-discovery and one handler-map module...');
    startServer(done);
  });

  after((done) => {
    exec(`pkill -f "[f]ramework.js.*--port ${PORT}"`, () => { setTimeout(done, 1000); });
  });

  it('the dynamic path decides its device count at runtime', (done) => {
    toolNames((err, names) => {
      if (err) return done(err);
      const hello = names.filter((n) => /^dynamic_device_\d+_dynservice_hello$/.test(n));
      assert.strictEqual(hello.length, DEVICE_COUNT,
        `one module produced ${hello.length} devices, expected ${DEVICE_COUNT}: ${names.join(', ')}`);
      return done();
    });
  });

  it('the handler-map path produces exactly one device, with no discovery', (done) => {
    toolNames((err, names) => {
      if (err) return done(err);
      const own = names.filter((n) => n.indexOf('handler_map_module_') === 0);
      assert.deepStrictEqual(own, ['handler_map_module_greetservice_hello']);
      return done();
    });
  });

  it('both shapes answer calls in the same server', (done) => {
    call('dynamic_device_1_dynservice_hello', {}, (err, dyn) => {
      if (err) return done(err);
      assert.strictEqual(dyn.isError, false, JSON.stringify(dyn));
      assert.deepStrictEqual(dyn.structuredContent, {output: {name: 'dynamic-device-1'}});

      call('handler_map_module_greetservice_hello', {name: 'x'}, (err2, hm) => {
        if (err2) return done(err2);
        assert.strictEqual(hm.isError, false, JSON.stringify(hm));
        assert.deepStrictEqual(hm.structuredContent, {output: {text: 'hello x'}});
        return done();
      });
    });
  });

  it('deviceoffline withdraws one device without touching its siblings', (done) => {
    call('dynamic_device_2_dynservice_retire', {}, (err, retired) => {
      if (err) return done(err);
      assert.strictEqual(retired.isError, false, JSON.stringify(retired));

      // the fixture defers the emit a tick so this reply lands first
      setTimeout(() => {
        call('dynamic_device_2_dynservice_hello', {}, (err2, gone) => {
          if (err2) return done(err2);
          assert.strictEqual(gone.isError, true, 'a retired device must stop answering');
          assert.strictEqual(gone.structuredContent.code, 'DEVICE_OFFLINE', JSON.stringify(gone));

          call('dynamic_device_1_dynservice_hello', {}, (err3, alive) => {
            if (err3) return done(err3);
            assert.strictEqual(alive.isError, false,
              `a sibling from the same module must be unaffected: ${JSON.stringify(alive)}`);

            call('handler_map_module_greetservice_hello', {name: 'y'}, (err4, other) => {
              if (err4) return done(err4);
              assert.strictEqual(other.isError, false,
                `the handler-map module must be unaffected: ${JSON.stringify(other)}`);
              return done();
            });
          });
        });
      }, 1500);
    });
  });
});
