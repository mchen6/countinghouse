var fs   = require('fs');
var path = require('path');

var loadDeviceConfig = require('../../lib/device-config');

// Pure unit tests, no server -- same style as test/auth/02-file-provider-unit.js.
// Covers lib/device-config.js's file backend (replaces the old CouchDB
// device-config db, never migrated -- see
// docs/design-decisions.md's AuthProvider section): reading
// <moduleName>.json from the configured directory, the "no file" case
// (empty config, not an error), and a corrupt-JSON file surfacing as a
// real error rather than crashing.
describe('device-config 01: file backend', function() {
  var configDir = '/tmp/countinghouse-test-device-config-' + process.pid;

  before(function() {
    fs.mkdirSync(configDir, {recursive: true});
  });

  beforeEach(function() {
    delete global.DeviceConfig;
  });

  after(function() {
    fs.rmSync(configDir, {recursive: true, force: true});
  });

  it('loads <moduleName>.json into global.DeviceConfig when present', function(done) {
    var moduleName = 'some-module';
    fs.writeFileSync(path.join(configDir, moduleName + '.json'), JSON.stringify({setting: 'value', nested: {a: 1}}));

    loadDeviceConfig({deviceConfigPath: configDir, workerThread: true}, moduleName, function(err) {
      if (err) return done(err);
      if (global.DeviceConfig == null || global.DeviceConfig.setting !== 'value' || global.DeviceConfig.nested.a !== 1) {
        return done(new Error('expected global.DeviceConfig to be loaded from file, got: ' + JSON.stringify(global.DeviceConfig)));
      }
      done();
    });
  });

  it('no file for the module is not an error -- global.DeviceConfig ends up an empty object', function(done) {
    loadDeviceConfig({deviceConfigPath: configDir, workerThread: true}, 'no-such-module', function(err) {
      if (err) return done(err);
      if (global.DeviceConfig == null || Object.keys(global.DeviceConfig).length !== 0) {
        return done(new Error('expected an empty global.DeviceConfig, got: ' + JSON.stringify(global.DeviceConfig)));
      }
      done();
    });
  });

  it('a missing config directory entirely (not just a missing file) is also not an error', function(done) {
    loadDeviceConfig({deviceConfigPath: configDir + '-does-not-exist', workerThread: true}, 'anything', function(err) {
      if (err) return done(err);
      if (global.DeviceConfig == null || Object.keys(global.DeviceConfig).length !== 0) {
        return done(new Error('expected an empty global.DeviceConfig, got: ' + JSON.stringify(global.DeviceConfig)));
      }
      done();
    });
  });

  it('corrupt JSON surfaces as a real error, not a crash', function(done) {
    var moduleName = 'broken-module';
    fs.writeFileSync(path.join(configDir, moduleName + '.json'), '{ this is not valid json');

    loadDeviceConfig({deviceConfigPath: configDir, workerThread: true}, moduleName, function(err) {
      if (err == null) return done(new Error('expected an error for corrupt JSON, got none'));
      // even on error, global.DeviceConfig must still end up a safe, usable object
      if (global.DeviceConfig == null || Object.keys(global.DeviceConfig).length !== 0) {
        return done(new Error('expected global.DeviceConfig to still be a safe empty object after an error, got: ' + JSON.stringify(global.DeviceConfig)));
      }
      done();
    });
  });
});
