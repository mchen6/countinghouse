// MCP completeness M3, spec section 1, end to end: a Buffer, a typed array
// or a DataView in a module's output is not JSON. Today it is mangled
// differently in each mode; now the module's worker refuses it as it
// serializes the reply (a serializer that flags an ArrayBuffer view as it
// meets one, so a clean output pays nothing), OUTPUT_NOT_JSON naming the
// field and saying to return base64 in a declared binary field. Even under
// a field its schema leaves untyped, which no type check would catch. And a
// field declared contentEncoding: base64 must be canonical base64.
const assert = require('assert');
const fs     = require('fs');
const http   = require('http');
const net    = require('net');
const path   = require('path');
const spawn  = require('child_process').spawn;
const {testPort} = require('../helpers/test-env');

const PORT = testPort(9576);
const ROOT = path.join(__dirname, '..', '..');
const KEY  = 'aabbcc';

let server;
let deviceID;

function stopServer() {
  if (server == null || server.pid == null) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  server = null;
}

function assertPortFree(callback) {
  let done = false;
  const socket = net.connect({host: '127.0.0.1', port: PORT});
  function finish(err) {
    if (done) return;
    done = true;
    socket.destroy();
    callback(err);
  }
  socket.setTimeout(2000);
  socket.on('connect', () => {
    finish(new Error(`port ${PORT} is already in use; kill it (fuser -k ${PORT}/tcp) first`));
  });
  socket.on('timeout', () => { finish(null); });
  socket.on('error',   () => { finish(null); });
}

function post(urlPath, body, callback) {
  const payload = JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CH-Key': KEY, 'Content-Length': Buffer.byteLength(payload)}
  }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      let body;
      try { body = JSON.parse(data); } catch (e) { return callback(new Error(`non-JSON response (${res.statusCode}): ${data.slice(0, 200)}`)); }
      callback(null, res.statusCode, body);
    });
  });
  req.on('error', callback);
  req.end(payload);
}

function get(urlPath, callback) {
  http.get({host: '127.0.0.1', port: PORT, path: urlPath, headers: {'X-CH-Key': KEY}}, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      try { callback(null, JSON.parse(data)); } catch (e) { callback(new Error(`non-JSON: ${data.slice(0, 200)}`)); }
    });
  }).on('error', callback);
}

function invoke(actionName, callback) {
  post(`/devices/${deviceID}/invoke-action`,
       {serviceID: 'urn:countinghouse-test:serviceID:svc', actionName: actionName, input: {}},
       callback);
}

describe('validation 19 (unit): serializeOutput flags an ArrayBuffer view, and only that', () => {
  const {serialize, serializeOutput, NotJson, notJsonError} = require('../../lib/serialized-result');
  const flagged = (reply) => {
    try { serializeOutput(reply); } catch (e) { if (e instanceof NotJson) return notJsonError(e, reply, 'm', 'a'); throw e; }
    return null;
  };
  it('a clean output\'s bytes are serialize()\'s exactly', () => {
    const cycle = {a: 1};
    cycle.self = cycle;
    for (const v of [{output: {}}, {output: {s: 'x', n: 1.5, b: true, z: null, a: [1, [2, {c: 'd'}]]}}, {output: new Map([['k', 'v']])},
      {output: {d: new Date(0), r: /x/g, big: 10n}}, {output: cycle}, {output: 'a string'}]) {
      assert.strictEqual(Buffer.compare(serializeOutput(v), serialize(v)), 0, JSON.stringify(Object.keys(v.output)));
    }
  });
  it('each kind of view is OUTPUT_NOT_JSON with its pointer into the output', () => {
    const cases = [
      [{output: {data: Buffer.from('x')}}, '/data'],
      [{output: {a: [0, {u: new Uint8Array(1)}]}}, '/a/1/u'],
      [{output: {f: new Float64Array(1)}}, '/f'],
      [{output: {d: new DataView(new ArrayBuffer(1))}}, '/d'],
      [{output: {'x/y~z': new Int16Array(1)}}, '/x~1y~0z'],
      [{output: {m: new Map([['k', new Uint8Array(1)]])}}, '/m/k'],
      [{output: new Uint8Array(1)}, '(the whole output)']
    ];
    for (const [reply, field] of cases) {
      const e = flagged(reply);
      assert.ok(e != null, field);
      assert.strictEqual(e.code, 'OUTPUT_NOT_JSON');
      assert.ok(e.message.includes(` at ${field},`), `${field}: ${e.message}`);
      assert.ok(e.message.startsWith('m/a: '), e.message);
    }
  });
  it('a bare ArrayBuffer is not flagged: it is left to the validator\'s type check (the reviewer\'s ruling)', () => {
    assert.strictEqual(flagged({output: {ab: new ArrayBuffer(4)}}), null);
  });
});

const NOT_JSON = /return buf\.toString\('base64'\) in a field its output schema declares contentEncoding: base64/;

describe('validation 19: a module output that is not JSON is refused OUTPUT_NOT_JSON, end to end', function() {
  this.timeout(0);

  before((done) => {
    assertPortFree((err) => {
      if (err) return done(err);
      server = spawn(path.join(ROOT, 'bin', 'countinghouse'),
        ['--workerThread', '--debug', '--bindAddr', '127.0.0.1', '--port', String(PORT), '--debugKey', KEY,
         '--loadModule', path.join(ROOT, 'test', 'fixtures', 'not-json-output-module')],
        {cwd: ROOT, stdio: 'ignore', detached: true});
      const deadline = Date.now() + 60000;
      const poll = () => get('/device-list', (e, list) => {
        const hit = (!e && Array.isArray(list)) ? list.filter((d) => d.device && d.device.friendlyName === 'not-json-output-module')[0] : null;
        if (hit != null) { deviceID = hit.device.deviceID; return done(); }
        if (Date.now() > deadline) return done(new Error(`fixture module did not load: ${e ? e.message : JSON.stringify(list)}`));
        setTimeout(poll, 500);
      });
      setTimeout(poll, 1000);
    });
  });

  after(() => {
    stopServer();
  });

  const refused = (action, field) => (done) => {
    invoke(action, (err, status, body) => {
      if (err) return done(err);
      assert.strictEqual(status, 500, JSON.stringify(body));
      assert.strictEqual(body.code, 'OUTPUT_NOT_JSON', JSON.stringify(body));
      assert.ok(JSON.stringify(body).includes(field), `names ${field}: ${JSON.stringify(body)}`);
      assert.match(JSON.stringify(body).replace(/\\/g, ''), NOT_JSON);
      done();
    });
  };

  it('a Buffer in a field declared base64', refused('returnsBuffer', '/data'));
  it('a Uint8Array in an array item', refused('returnsNestedView', '/items/1/u'));
  it('a DataView under a field its schema leaves untyped', refused('returnsUntypedView', '/blob'));

  it('canonical base64 in the declared field is served as it was returned', (done) => {
    invoke('returnsBase64', (err, status, body) => {
      if (err) return done(err);
      assert.strictEqual(status, 200, JSON.stringify(body));
      assert.deepStrictEqual(body, {output: {data: Buffer.from('png bytes').toString('base64')}});
      done();
    });
  });

  it('base64 with a pad bit set is refused by the validator, naming the field', (done) => {
    invoke('returnsBadBase64', (err, status, body) => {
      if (err) return done(err);
      assert.strictEqual(status, 500, JSON.stringify(body));
      assert.strictEqual(body.code, 'OUTPUT_DATA_VALIDATION_FAIL', JSON.stringify(body));
      assert.match(JSON.stringify(body), /data/);
      done();
    });
  });

  it('the server is still standing afterwards', (done) => {
    invoke('returnsBase64', (err, status) => {
      if (err) return done(err);
      assert.strictEqual(status, 200);
      done();
    });
  });
});
