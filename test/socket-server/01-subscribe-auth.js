var fs   = require('fs');
var exec = require('child_process').exec;
var io   = require('socket.io-client');

var url = 'http://127.0.0.1:9527';

// Standalone-only, same reason as test/auth/01-file-provider-tools-list-filtering.js:
// needs a real (non---debug) server, since --debug bypasses AuthProvider
// (and therefore this gate) entirely. Covers lib/socket-server.js's two
// auth layers: a handshake-time identity check (io.use()) and a
// per-subscribe device-access check, added because this event channel
// previously read no apiKey at all (see docs/cross-cutting-matrix.md's
// event-channel row and README's now-updated --sioServer row).
var AUTH_CONFIG_PATH = '/tmp/countinghouse-test-socket-server-01-' + process.pid + '.json';

var ECHO_DEVICE_ID = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767'; // echo-device-module

var AUTHORIZED_KEY   = 'authorized-key';   // granted ECHO_DEVICE_ID
var WRONG_DEVICE_KEY = 'wrong-device-key'; // valid apiKey, granted a different device only
var UNKNOWN_KEY      = 'unknown-key';      // not present in auth.json at all

describe('socket-server 01: subscribe requires AuthProvider authorization (same semantics as HTTP/MCP)', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    var config = {};
    config[AUTHORIZED_KEY]   = {userName: 'authorized-user',   devices: [ECHO_DEVICE_ID]};
    config[WRONG_DEVICE_KEY] = {userName: 'wrong-device-user', devices: ['some-other-device']};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse WITHOUT --debug, --workerThread, --authProvider file, --sioServer, for socket-server auth test...');
    // Deliberately NOT --workerThread: DeviceManager.onEventSubscribe calls
    // cdifDevice.subscribeDeviceEvent(...), which the main-thread
    // WorkerMessage proxy (lib/worker-message.js) does not implement --
    // any subscribe that gets past auth crashes with "cdifDevice.
    // subscribeDeviceEvent is not a function" under --workerThread
    // (silently, caught by the domain wrapping DeviceManager's emit, never
    // reaching this test's socket at all -- found while writing this
    // test). That gap is pre-existing and unrelated to the auth work this
    // file covers, so it's sidestepped here rather than fixed; single-
    // thread mode calls the real device instance directly and doesn't
    // have it.
    exec('"./bin/countinghouse" --bindAddr 127.0.0.1 --authProvider file --authConfigPath ' + AUTH_CONFIG_PATH +
         ' --sioServer --loadModule ./pre-installed-packages/echo-device-module',
         function(err, stdout, stderr) { console.log(err); });
    setTimeout(function() { done(); }, 13000);
  });

  after(function(done) {
    fs.unlinkSync(AUTH_CONFIG_PATH);
    // Same reason as test/auth/01-file-provider-tools-list-filtering.js's
    // after(): this server's auth.json grants no key admin rights, so
    // /shutdown would just 403 -- kill the process directly instead,
    // matched via the unique --authConfigPath value on its command line.
    exec('pkill -f "framework.js.*' + AUTH_CONFIG_PATH + '"', function() { done(); });
  });

  var SUBSCRIBE_INFO = {deviceID: ECHO_DEVICE_ID, serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {}};

  // Connects with the given handshake `auth` payload, optionally emits
  // 'subscribe', and resolves with whichever happens first: a handshake
  // connect_error, a post-connect 'error' event, or -- if neither fires
  // within `timeoutMs` -- null (treated as "got past every auth check
  // this test cares about", since a clean subscribe emits nothing back).
  function attempt(auth, subscribeInfo, timeoutMs, cb) {
    var sock = io(url, {auth: auth, reconnection: false, forceNew: true, timeout: 4000});
    var done = false;

    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(t);
      sock.close();
      return cb(result);
    }

    sock.on('connect_error', function(err) {
      finish({source: 'connect_error', code: err.data != null ? err.data.code : null});
    });
    sock.on('connect', function() {
      if (subscribeInfo == null) return finish(null);
      sock.on('error', function(err) {
        finish({source: 'subscribe', code: err.code});
      });
      sock.emit('subscribe', JSON.stringify(subscribeInfo));
    });

    var t = setTimeout(function() { finish(null); }, timeoutMs);
  }

  it('no apiKey at all: connection is rejected at handshake with SYSTEM_ERROR_UNKNOWN_USER, subscribe never reached', function(done) {
    attempt({}, SUBSCRIBE_INFO, 4000, function(result) {
      if (result == null || result.source !== 'connect_error' || result.code !== 'SYSTEM_ERROR_UNKNOWN_USER') {
        return done(new Error('expected a connect_error with SYSTEM_ERROR_UNKNOWN_USER, got: ' + JSON.stringify(result)));
      }
      return done();
    });
  });

  it('unknown apiKey: connection is rejected at handshake with SYSTEM_ERROR_UNKNOWN_USER, subscribe never reached', function(done) {
    attempt({apiKey: UNKNOWN_KEY}, SUBSCRIBE_INFO, 4000, function(result) {
      if (result == null || result.source !== 'connect_error' || result.code !== 'SYSTEM_ERROR_UNKNOWN_USER') {
        return done(new Error('expected a connect_error with SYSTEM_ERROR_UNKNOWN_USER, got: ' + JSON.stringify(result)));
      }
      return done();
    });
  });

  it('known apiKey without access to this device: connects fine, but subscribe is denied with USER_HAS_NO_DEVICE', function(done) {
    attempt({apiKey: WRONG_DEVICE_KEY}, SUBSCRIBE_INFO, 4000, function(result) {
      if (result == null || result.source !== 'subscribe' || result.code !== 'USER_HAS_NO_DEVICE') {
        return done(new Error('expected a subscribe-time USER_HAS_NO_DEVICE error, got: ' + JSON.stringify(result)));
      }
      return done();
    });
  });

  // echo-device-module's 'echo' action isn't a real event source, so this
  // can still surface a device-level error (e.g. EVENT_SUBSCRIPTION_FAIL)
  // even once past this file's auth gate -- that's fine and expected, and
  // still proves the point: an auth-layer code (SYSTEM_ERROR_UNKNOWN_USER,
  // USER_HAS_NO_DEVICE) would mean this test's own gate rejected it;
  // anything else, including silence, means it didn't.
  var AUTH_CODES = ['SYSTEM_ERROR_UNKNOWN_USER', 'USER_HAS_NO_DEVICE'];

  it('authorized apiKey for this device: gets past both auth checks (no auth-layer error)', function(done) {
    attempt({apiKey: AUTHORIZED_KEY}, SUBSCRIBE_INFO, 4000, function(result) {
      if (result != null && AUTH_CODES.indexOf(result.code) !== -1) {
        return done(new Error('expected to get past the auth gate, got an auth-layer error instead: ' + JSON.stringify(result)));
      }
      return done();
    });
  });
});
