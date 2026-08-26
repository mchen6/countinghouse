// DeviceManager.prototype.onDeviceOnline's duplicate-deviceID guard
// (lib/device-manager.js, the existingConflict check right before
// `cdifDevice.module = moduleInstance;`) had zero end-to-end coverage.
// 01-worker-mode-conflict-guard.js only exercises the OTHER call site,
// DeviceManager.prototype.onWorkerLoaded's 'deviceonline' handler -- the
// worker-mode path. This is the single-thread path's turn, driven through a
// real spawned server rather than a unit-level emit, the way
// 02-ctx-call.js's single-thread describe block shows is cheap to do.
// device-id-conflict.js's own header notes this exact guard silently
// regressed once already on this branch (worker mode overwrote the first
// registration silently before that file existed) -- closing the sibling
// hole here.
//
// test/fixtures/dup-deviceid-first and .../dup-deviceid-second declare the
// SAME device.friendlyName ("dup-deviceid-target"), and therefore the same
// deviceID (callAddress.deviceIDForName hashes friendlyName) -- two
// different, unrelated module authors (different package.json "name")
// picking the same friendlyName by accident, same scenario the guard
// exists for. -first loads first and must win; -second loads second and
// must be refused outright, not silently overwrite the first. They declare
// different action names (ping vs. pingSecond) precisely so a broken guard
// is observable two ways below, not just "nothing crashed".
//
// Proof this test actually exercises the guard, not just plumbing: with the
// `if (existingConflict != null) { ... }` block in onDeviceOnline commented
// out by hand, all three assertions below fail -- the conflict log line
// disappears, dup_deviceid_target_pingservice_ping starts answering
// 'second' (dup-deviceid-second's device object silently replaces
// dup-deviceid-first's in deviceMap), and
// dup_deviceid_target_pingservice_pingsecond appears in tools/list. Restored
// before this file was committed.
const assert  = require('assert');
const path    = require('path');
const request = require('supertest');
const spawn   = require('child_process').spawn;

// Same reasoning as 02-ctx-call.js and friends: something downstream reaches
// lib/countinghouse-util.js at require time, which needs options.redisUrl.
require('../../lib/cli-options').setOptions({});

const PORT      = 9561;
const FIXTURES  = path.join(__dirname, '..', 'fixtures');
const BASE      = `http://127.0.0.1:${PORT}`;
const DEBUG_KEY = 'dup-deviceid-test-key';

const FIRST_PATH  = path.join(FIXTURES, 'dup-deviceid-first');
const SECOND_PATH = path.join(FIXTURES, 'dup-deviceid-second');

let server;
let serverLog = '';

function startServer(done) {
  server = spawn(process.execPath, [
    path.join(__dirname, '..', '..', 'framework.js'),
    // --debug/--debugKey bypasses AuthProvider entirely (lib/user-auth.js) --
    // this test is about device registration, not composition/auth, so no
    // --authConfigPath is needed.
    '--debug', '--debugKey', DEBUG_KEY,
    '--bindAddr', '127.0.0.1', '--port', String(PORT),
    '--loadModule', FIRST_PATH,
    '--loadModule', SECOND_PATH
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  const onData = (buf) => {
    serverLog += buf.toString();
    if (/all module discovered/i.test(serverLog)) {
      setTimeout(done, 2500);
      server.stdout.removeListener('data', onData);
      server.stderr.removeListener('data', onData);
    }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
}

function rpc(body, cb) {
  request(BASE)
    .post('/mcp')
    .set('X-CH-Key', DEBUG_KEY)
    .set('Accept', 'application/json, text/event-stream')
    .send(body)
    .expect(200)
    .end((err, res) => {
      if (err) return cb(err);
      return cb(null, res.body);
    });
}

describe('single-thread deviceID conflict guard (DeviceManager.prototype.onDeviceOnline)', function() {
  this.timeout(40000);

  before((done) => startServer(done));
  // Await 'exit', not just issuing the kill -- see 02-ctx-call.js's after()
  // for why (this suite runs in the same process, back to back with other
  // composition files that bind their own ports).
  after((done) => {
    if (server == null) return done();
    server.on('exit', () => done());
    server.kill('SIGKILL');
  });

  it('logs the conflict, naming both fixture module paths', () => {
    // The de-serializer (lib/logger.js's deviceErrorSerializer) renders this
    // as "<friendlyName>: <message>" -- match the message text this file's
    // own device-manager.js fix writes, not the CHError code (error-info.json
    // maps DEVICE_OBJECT_CONFLICT to a human-readable phrase, not the code
    // itself).
    assert.ok(/already registered by/.test(serverLog),
      `expected a device-object-conflict log line, got:\n${serverLog}`);
    // The refused (second) fixture's path: printed unconditionally for
    // every --loadModule entry by ModuleManager.prototype.loadAllModules'
    // "load local module from path" line, regardless of what happens next.
    assert.ok(serverLog.indexOf(SECOND_PATH) !== -1,
      `expected the second (refused) fixture's path in the log, got:\n${serverLog}`);
    // The already-registered (first) fixture's path: named directly inside
    // the conflict message itself ("... already registered by <path> ...").
    assert.ok(serverLog.indexOf(FIRST_PATH) !== -1,
      `expected the first (already-registered) fixture's path in the log, got:\n${serverLog}`);
  });

  it('the first-registered device keeps serving its own action', (done) => {
    rpc({jsonrpc: '2.0', id: 1, method: 'tools/call',
         params: {name: 'dup_deviceid_target_pingservice_ping', arguments: {}}}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false, JSON.stringify(body));
      assert.strictEqual(body.result.structuredContent.output.answeredBy, 'first', JSON.stringify(body));
      done();
    });
  });

  it('the second (colliding) module never registers -- its action is not listed', (done) => {
    rpc({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}, (err, body) => {
      assert.ifError(err);
      const names = body.result.tools.map((t) => t.name);
      assert.strictEqual(names.indexOf('dup_deviceid_target_pingservice_pingsecond'), -1,
        `pingSecond must never be listed -- its module should have been refused as a conflict, got: ${
        JSON.stringify(names)}`);
      done();
    });
  });
});
