// Dynamic discovery is retired (lean worker, step 1; Matt, 2026-11-13: "CDIF
// style modules should be retired"). This file used to show both module
// shapes in one server: a handler map (one device from api.json) and a
// class / EventEmitter main entry that decided its device count at runtime
// and withdrew a device with 'deviceoffline'. A module is now api.json,
// schema.json and handlers/ (lib/module-layout.js); the dynamic module's
// main entry with no handlers/ directory is refused before any of its code
// runs (MODULE_LAYOUT_UNSUPPORTED). What this file pins now: the dynamic
// module produces no device, and the handler-map module beside it, in the
// same server, loads and answers as before.
const assert = require('assert');
const http   = require('http');
const waitForReady = require('../helpers/wait-for-ready');
const {testPort, redisFlag, startShell, stopAll} = require('../helpers/test-env');
const {toolOutput} = require('../helpers/tool-result');

const PORT   = testPort(9586);

function startServer(done) {
  waitForReady(startShell(`NODE_PATH=./lib node ./framework.js${redisFlag()} --no-workerThread --debug` +
       ` --bindAddr 127.0.0.1 --port ${PORT} --debugKey aabbcc` +
       ` --loadModule ./test/fixtures/dynamic-discovery-module` +
       ` --loadModule ./test/fixtures/handler-map-module` +
       ` 2> /dev/null`, () => {}), done);
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

describe('module-loading 06: a dynamic-discovery module is refused; a handler-map module beside it is not', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    startServer(done);
  });

  after((done) => {
    stopAll(done, 1000);
  });

  it('the dynamic-discovery module produces no device', (done) => {
    toolNames((err, names) => {
      if (err) return done(err);
      assert.deepStrictEqual(names.filter((n) => /dynservice/.test(n)), [], names.join(', '));
      return done();
    });
  });

  it('the handler-map module produces exactly one device, and answers', (done) => {
    toolNames((err, names) => {
      if (err) return done(err);
      assert.deepStrictEqual(names.filter((n) => n.indexOf('handler_map_module_') === 0), ['handler_map_module_greetservice_hello']);
      call('handler_map_module_greetservice_hello', {name: 'x'}, (err2, hm) => {
        if (err2) return done(err2);
        assert.strictEqual(hm.isError, false, JSON.stringify(hm));
        assert.deepStrictEqual(toolOutput(hm), {text: 'hello x', caller: 'aabbcc'});
        return done();
      });
    });
  });
});
