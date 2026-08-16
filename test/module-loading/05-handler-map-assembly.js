// End-to-end cover for the 6.0.0 handler-map module shape, through a real
// server and the real MCP surface. 04-handler-map-validation.js covers the
// same rules at unit level; this one proves they actually hold once the whole
// load path is involved.
//
// Two things are asserted together on purpose:
//
//   1. a handler-map module works with zero boilerplate -- no index.js, no
//      setAction, no _getDeviceRootSchema. Both supported layouts are
//      exercised: the map exported from device.js, and the handlers/ tree.
//   2. every kind of api.json/handler mismatch fails *loudly and specifically*
//      and in isolation. Convention-based assembly makes silent mismatches
//      cheap to produce, and "a module with an illegal spec just disappears"
//      is a defect class this repo has already fixed once -- see
//      03-legacy-spec-not-silent.js. It must not return through this door.
const assert = require('assert');
const fs     = require('fs');
const http   = require('http');
const exec   = require('child_process').exec;

const PORT = 9584;
const LOG  = `/tmp/countinghouse-test-handler-map-${process.pid}.log`;

// framework.js directly, not bin/countinghouse: the launcher pipes stdout
// through bunyan when bunyan is on PATH, and this file reads the log as JSON.
// Same reasoning as 01 and 03.
function startServer(done) {
  exec(`NODE_PATH=./lib node ./framework.js --debug --bindAddr 127.0.0.1 --port ${PORT
       } --debugKey aabbcc` +
       ` --loadModule ./test/fixtures/handler-map-missing-action` +
       ` --loadModule ./test/fixtures/handler-map-undeclared-action` +
       ` --loadModule ./test/fixtures/handler-map-unknown-service` +
       ` --loadModule ./test/fixtures/handler-map-module` +
       ` --loadModule ./test/fixtures/handler-map-convention` +
       ` > ${LOG} 2>&1`, () => {});
  setTimeout(done, 14000);
}

function errorRecords() {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(LOG, 'utf8'); } catch (e) { return out; }

  raw.split('\n').forEach((line) => {
    if (line.trim() === '') return;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { return; }
    if (rec.level == null || rec.level < 40) return;   // 40 = bunyan ERROR
    const text = (typeof(rec.e) === 'string') ? rec.e
             : (rec.de != null ? JSON.stringify(rec.de) : JSON.stringify(rec));
    out.push(text);
  });
  return out;
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

// the record for one module, or '' -- named rather than indexed so a failure
// message says which module was not diagnosed
function recordFor(moduleName) {
  return errorRecords().filter((r) => r.indexOf(moduleName) !== -1).join('\n');
}

describe('module-loading 05: handler-map assembly, end to end', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    console.log('starting countinghouse with three broken and two valid handler-map modules...');
    startServer(done);
  });

  after((done) => {
    rpc({jsonrpc: '2.0', id: 99, method: 'tools/list'}, () => {
      exec(`pkill -f "[f]ramework.js.*--port ${PORT}"`, () => { setTimeout(done, 1000); });
    });
  });

  it('a handler map exported from device.js needs no index.js and no setAction', (done) => {
    rpc({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'handler_map_module_greetservice_hello', arguments: {name: 'world'}}}, (err, res) => {
      if (err) return done(err);
      assert.strictEqual(res.result.isError, false, JSON.stringify(res.result));
      assert.deepStrictEqual(res.result.structuredContent, {output: {text: 'hello world'}});
      return done();
    });
  });

  it('the handlers/<service>/<action>.js convention assembles the same way', (done) => {
    rpc({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'handler_map_convention_greetservice_hello', arguments: {name: 'convention'}}}, (err, res) => {
      if (err) return done(err);
      assert.strictEqual(res.result.isError, false, JSON.stringify(res.result));
      assert.deepStrictEqual(res.result.structuredContent, {output: {text: 'hello convention'}});
      return done();
    });
  });

  it('schema.json is read by the framework, so input validation still applies', (done) => {
    rpc({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'handler_map_module_greetservice_hello', arguments: {}}}, (err, res) => {
      if (err) return done(err);
      assert.strictEqual(res.result.isError, true);
      assert.strictEqual(res.result.structuredContent.code, 'INPUT_DATA_VALIDATION_FAIL');
      return done();
    });
  });

  it('a declared action with no handler fails loudly, naming module/stage/action/fix', () => {
    const rec = recordFor('handler-map-missing-action');
    assert.notStrictEqual(rec, '', 'the failure must not be silent');
    assert.ok(rec.indexOf('stage=assembleHandlerMap') !== -1, rec);
    assert.ok(rec.indexOf('greetService.hello') !== -1, rec);
    assert.ok(/Add it, or remove the action/.test(rec), `must say how to fix it: ${rec}`);
  });

  it('an undeclared handler fails loudly, listing what api.json does declare', () => {
    const rec = recordFor('handler-map-undeclared-action');
    assert.notStrictEqual(rec, '', 'the failure must not be silent');
    assert.ok(rec.indexOf('greetService.goodbye') !== -1, rec);
    assert.ok(/Actions declared on .*: hello/.test(rec), `must list the declared actions: ${rec}`);
    assert.ok(/typo/.test(rec), rec);
  });

  it('an unresolvable service short name fails loudly, and says short-name-not-URN', () => {
    const rec = recordFor('handler-map-unknown-service');
    assert.notStrictEqual(rec, '', 'the failure must not be silent');
    assert.ok(rec.indexOf('greetingService') !== -1, rec);
    assert.ok(rec.indexOf('service short names') !== -1, `must explain the key format: ${rec}`);
    // both directions reported from one load, not just the first
    assert.ok(/2 problem\(s\)/.test(rec), `must report every mismatch at once: ${rec}`);
  });

  it('broken modules contribute no tools, and the valid ones are unaffected', (done) => {
    rpc({jsonrpc: '2.0', id: 4, method: 'tools/list'}, (err, res) => {
      if (err) return done(err);
      const names = res.result.tools.map((t) => t.name);

      assert.ok(names.indexOf('handler_map_module_greetservice_hello') !== -1, names.join(', '));
      assert.ok(names.indexOf('handler_map_convention_greetservice_hello') !== -1, names.join(', '));

      const leaked = names.filter((n) => /missing_action|undeclared_action|unknown_service|goodbye/.test(n));
      assert.deepStrictEqual(leaked, [], `broken modules must contribute nothing: ${leaked.join(', ')}`);
      return done();
    });
  });
});
