// Default AuthProvider implementation (see provider.js): a flat JSON file,
// no external database required. Shape:
//
//   {
//     "<apiKey>": {"userName": "...", "devices": ["<deviceID>", ...]}
//   }
//
// `devices` may contain the literal string "*" to mean "every device" --
// authenticate() and listDevices() both pass that through rather than
// resolving it against the live device set (see provider.js's listDevices
// comment for why).
var fs      = require('fs');
var CHError = require('../countinghouse-error').CHError;
var LOG     = require('../logger');
var AuthProvider = require('./provider');

function FileAuthProvider(opts) {
  AuthProvider.call(this);
  opts = opts || {};

  this.configPath = opts.configPath || (process.cwd() + '/auth.json');
  this.config = {};
  this._load();
}

require('util').inherits(FileAuthProvider, AuthProvider);

// Loaded once at construction, not re-read per call -- matches how
// --loadModule-sourced config is already treated elsewhere in this
// codebase (static for the life of the process; changing it requires a
// restart). A missing file is not an error here -- FileAuthProvider.prototype
// callers (lib/auth/index.js) are responsible for first-run ergonomics
// (auto-generating a demo key) before this constructor ever runs; a
// missing file at this layer just means "no one is authorized yet".
FileAuthProvider.prototype._load = function() {
  var raw;
  try {
    raw = fs.readFileSync(this.configPath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') LOG.E(new Error('FileAuthProvider: failed to read ' + this.configPath + ': ' + e.message));
    this.config = {};
    return;
  }

  try {
    this.config = JSON.parse(raw);
  } catch (e) {
    LOG.E(new Error('FileAuthProvider: ' + this.configPath + ' is not valid JSON: ' + e.message));
    this.config = {};
  }
};

FileAuthProvider.prototype._lookup = function(apiKey) {
  if (apiKey == null || this.config[apiKey] == null) return null;
  var entry = this.config[apiKey];
  return {
    userName: entry.userName != null ? entry.userName : apiKey,
    devices:  Array.isArray(entry.devices) ? entry.devices : []
  };
};

FileAuthProvider.prototype.authenticate = function(apiKey, deviceID, serviceID, actionName, callback) {
  var entry = this._lookup(apiKey);
  if (entry == null) return callback(null, {ok: false, userName: null, err: new CHError('SYSTEM_ERROR_UNKNOWN_USER', apiKey)});

  if (deviceID != null) {
    var hasDevice = entry.devices.indexOf('*') !== -1 || entry.devices.indexOf(deviceID) !== -1;
    if (hasDevice !== true) return callback(null, {ok: false, userName: entry.userName, err: new CHError('USER_HAS_NO_DEVICE')});
  }

  return callback(null, {ok: true, userName: entry.userName, err: null});
};

FileAuthProvider.prototype.listDevices = function(apiKey, callback) {
  var entry = this._lookup(apiKey);
  return callback(null, {devices: entry != null ? entry.devices : []});
};

module.exports = FileAuthProvider;
