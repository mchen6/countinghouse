// The same rule as 01, but end to end: a real module, loaded into a real
// server, returning an argument its spec never declared.
//
// Worth having separately from the unit test because the interesting part is
// what the *caller* sees. Before 5.0.0 this case dereferenced
// argList[key].relatedStateVariable on undefined and threw a TypeError out of
// validateActionCall, whose callers do not catch it on the input path; after
// the format change it was silently ignored and the stray key travelled back
// to the caller. Neither is a diagnosis, so this pins the third behaviour: a
// 500 naming the offending argument, and a server still standing afterwards.
var assert = require('assert');
var fs     = require('fs');
var http   = require('http');
var net    = require('net');
var path   = require('path');
var spawn  = require('child_process').spawn;

var PORT = 9575;
var ROOT = path.join(__dirname, '..', '..');
var KEY  = 'aabbcc';

var server;
var deviceID;

function stopServer() {
  if (server == null || server.pid == null) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  server = null;
}

function assertPortFree(callback) {
  var done = false;
  var socket = net.connect({host: '127.0.0.1', port: PORT});
  function finish(err) {
    if (done) return;
    done = true;
    socket.destroy();
    callback(err);
  }
  socket.setTimeout(2000);
  socket.on('connect', function() {
    finish(new Error('port ' + PORT + ' is already in use; kill it (fuser -k ' + PORT + '/tcp) first'));
  });
  socket.on('timeout', function() { finish(null); });
  socket.on('error',   function() { finish(null); });
}

function post(urlPath, body, callback) {
  var payload = JSON.stringify(body);
  var req = http.request({
    host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-CH-Key': KEY, 'Content-Length': Buffer.byteLength(payload)}
  }, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      try { callback(null, res.statusCode, JSON.parse(data)); }
      catch (e) { callback(new Error('non-JSON response (' + res.statusCode + '): ' + data.slice(0, 200))); }
    });
  });
  req.on('error', callback);
  req.end(payload);
}

function get(urlPath, callback) {
  http.get({host: '127.0.0.1', port: PORT, path: urlPath, headers: {'X-CH-Key': KEY}}, function(res) {
    var data = '';
    res.on('data', function(c) { data += c; });
    res.on('end', function() {
      try { callback(null, JSON.parse(data)); } catch (e) { callback(new Error('non-JSON: ' + data.slice(0, 200))); }
    });
  }).on('error', callback);
}

function invoke(actionName, callback) {
  post('/devices/' + deviceID + '/invoke-action',
       {serviceID: 'urn:countinghouse-test:serviceID:svc', actionName: actionName, input: {v: 'hello'}},
       callback);
}

describe('validation 02: a module returning an undeclared argument is refused, end to end', function() {
  this.timeout(0);

  before(function(done) {
    assertPortFree(function(err) {
      if (err) return done(err);
      server = spawn(path.join(ROOT, 'bin', 'countinghouse'),
        ['--debug', '--bindAddr', '127.0.0.1', '--port', String(PORT), '--debugKey', KEY,
         '--loadModule', path.join(ROOT, 'test', 'fixtures', 'stray-output-module')],
        {cwd: ROOT, stdio: 'ignore', detached: true});

      setTimeout(function() {
        get('/device-list', function(err, list) {
          if (err) return done(err);
          var hit = (list || []).filter(function(d) {
            return d.device && d.device.friendlyName === 'stray-output-module';
          })[0];
          if (hit == null) return done(new Error('fixture module did not load: ' + JSON.stringify(list)));
          deviceID = hit.device.deviceID;
          done();
        });
      }, 9000);
    });
  });

  after(function() {
    stopServer();
  });

  it('the control action, returning exactly what it declared, still works', function(done) {
    invoke('returnsCleanly', function(err, status, body) {
      if (err) return done(err);
      assert.strictEqual(status, 200, JSON.stringify(body));
      assert.deepStrictEqual(body, {output: {v: 'hello'}});
      done();
    });
  });

  it('the stray argument is refused with a 500 that names it', function(done) {
    invoke('returnsStrayKey', function(err, status, body) {
      if (err) return done(err);
      assert.strictEqual(status, 500, 'an undeclared output argument must not be served: ' + JSON.stringify(body));
      assert.strictEqual(body.code, 'OUTPUT_DATA_VALIDATION_FAIL');
      assert.strictEqual(body.fault.reason, 'unexpected output argument: surprise');
      done();
    });
  });

  it('the stray argument never reaches the caller', function(done) {
    invoke('returnsStrayKey', function(err, status, body) {
      if (err) return done(err);
      assert.ok(!('surprise' in body), 'the undeclared argument leaked to the caller: ' + JSON.stringify(body));
      done();
    });
  });

  it('the server is still standing afterwards -- it refused, it did not crash', function(done) {
    invoke('returnsCleanly', function(err, status, body) {
      if (err) return done(err);
      assert.strictEqual(status, 200, 'the rejection took the server (or the worker) down: ' + JSON.stringify(body));
      done();
    });
  });
});
