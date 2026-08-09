var fs   = require('fs');
var path = require('path');

var FileAuthProvider = require('../../lib/auth/file-provider');

// Pure unit tests -- no server needed, FileAuthProvider is instantiated
// directly. Covers the two zero-config ergonomics on top of the plain
// auth.json format (already covered end to end by
// 01-file-provider-tools-list-filtering.js): auto-generating and printing
// a demo key on first run, and COUNTINGHOUSE_API_KEY single-key mode.
describe('auth 02: FileAuthProvider ergonomics (demo key generation, COUNTINGHOUSE_API_KEY)', function() {
  var configPath = '/tmp/countinghouse-test-auth-02-' + process.pid + '.json';

  afterEach(function() {
    try { fs.unlinkSync(configPath); } catch (e) {}
    delete process.env.COUNTINGHOUSE_API_KEY;
  });

  function assertOk(err, result, msg) {
    if (err) throw err;
    if (result.ok !== true) throw new Error((msg || 'expected ok:true') + ', got: ' + JSON.stringify(result));
  }

  function assertDenied(err, result, msg) {
    if (err) throw err;
    if (result.ok !== false) throw new Error((msg || 'expected ok:false') + ', got: ' + JSON.stringify(result));
  }

  it('generates and persists a demo key with wildcard access when the config file does not exist', function(done) {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath); // paranoia: guarantee a true first-run

    var provider = new FileAuthProvider({configPath: configPath});

    if (!fs.existsSync(configPath)) throw new Error('expected auth.json to be written to ' + configPath);

    var written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    var keys = Object.keys(written);
    if (keys.length !== 1) throw new Error('expected exactly one generated demo key, got: ' + JSON.stringify(written));

    var demoKey = keys[0];
    if (written[demoKey].devices.indexOf('*') === -1) {
      throw new Error('expected the demo key to have wildcard device access, got: ' + JSON.stringify(written[demoKey]));
    }

    provider.authenticate(demoKey, 'any-device-id', null, null, function(err, result) {
      assertOk(err, result, 'the generated demo key should authenticate against any deviceID');

      // Re-instantiating (simulating a restart) must reuse the persisted
      // key, not generate a second, different one -- otherwise every
      // restart would silently invalidate whatever key an operator was
      // already using.
      var provider2 = new FileAuthProvider({configPath: configPath});
      provider2.authenticate(demoKey, 'any-device-id', null, null, function(err, result) {
        assertOk(err, result, 'the same demo key should still work after "restart" (re-instantiation)');
        done();
      });
    });
  });

  it('does not overwrite an existing (even empty) auth.json with a demo key', function(done) {
    fs.writeFileSync(configPath, JSON.stringify({}));

    var provider = new FileAuthProvider({configPath: configPath});
    var written = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (Object.keys(written).length !== 0) {
      throw new Error('expected an existing empty auth.json to be left alone, got: ' + JSON.stringify(written));
    }

    provider.authenticate('anything', 'any-device-id', null, null, function(err, result) {
      assertDenied(err, result, 'an empty auth.json should authorize nobody');
      done();
    });
  });

  it('COUNTINGHOUSE_API_KEY grants wildcard access without requiring auth.json to exist', function(done) {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    process.env.COUNTINGHOUSE_API_KEY = 'env-mode-key';

    var provider = new FileAuthProvider({configPath: configPath});

    if (fs.existsSync(configPath)) {
      throw new Error('COUNTINGHOUSE_API_KEY mode should not write a demo config file to ' + configPath);
    }

    provider.authenticate('env-mode-key', 'any-device-id', null, null, function(err, result) {
      assertOk(err, result, 'COUNTINGHOUSE_API_KEY value should authenticate with wildcard access');

      provider.authenticate('some-other-key', 'any-device-id', null, null, function(err, result) {
        assertDenied(err, result, 'a key other than COUNTINGHOUSE_API_KEY should still be denied');
        done();
      });
    });
  });

  it('COUNTINGHOUSE_API_KEY and auth.json entries both work at the same time', function(done) {
    var fileKeyConfig = {};
    fileKeyConfig['file-key'] = {userName: 'file-user', devices: ['some-device-id']};
    fs.writeFileSync(configPath, JSON.stringify(fileKeyConfig));
    process.env.COUNTINGHOUSE_API_KEY = 'env-mode-key';

    var provider = new FileAuthProvider({configPath: configPath});

    provider.authenticate('env-mode-key', 'any-device-id', null, null, function(err, result) {
      assertOk(err, result, 'env key should authenticate');

      provider.authenticate('file-key', 'some-device-id', null, null, function(err, result) {
        assertOk(err, result, 'file-configured key should still authenticate for its own device');
        done();
      });
    });
  });
});
