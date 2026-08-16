// Default AuthProvider implementation (see provider.js): a flat JSON file,
// no external database required. Shape:
//
//   {
//     "<apiKey>": {"userName": "...", "devices": ["<deviceID>", ...], "admin": true}
//   }
//
// `devices` may contain the literal string "*" to mean "every device" --
// authenticate() and listDevices() both pass that through rather than
// resolving it against the live device set (see provider.js's listDevices
// comment for why). `admin` is optional, defaults to false, and is a
// *separate* capability from `devices` -- it gates the module-lifecycle
// routes (lib/routes/admin-only.js), not device access.
//
// Two zero-config ergonomics on top of the file itself, in priority order:
//
// 1. COUNTINGHOUSE_API_KEY env var: if set, that value authenticates with
//    wildcard device access *and* admin rights, independent of (and in
//    addition to) whatever auth.json contains -- never written to the
//    file, doesn't require one to exist at all. Meant for quick/ephemeral/
//    containerized deployments where a single shared key is enough and
//    writing a file is friction.
// 2. If auth.json doesn't exist on disk AND COUNTINGHOUSE_API_KEY isn't
//    set, a random demo key with wildcard access is generated, written to
//    auth.json (so it survives a restart -- otherwise every restart would
//    invalidate whatever key was already handed out), and printed once.
//    An *empty* existing auth.json (`{}`) is left alone -- that's a
//    deliberate "no one is authorized yet" state, not a first-run.
const fs      = require('fs');
const crypto  = require('crypto');
const CHError = require('../countinghouse-error').CHError;
const LOG     = require('../logger');
const AuthProvider = require('./provider');

function FileAuthProvider(opts) {
  AuthProvider.call(this);
  opts = opts || {};

  this.configPath = opts.configPath || (`${process.cwd()}/auth.json`);
  this.envKey = (process.env.COUNTINGHOUSE_API_KEY != null && process.env.COUNTINGHOUSE_API_KEY !== '')
    ? process.env.COUNTINGHOUSE_API_KEY
    : null;
  this.config = {};
  this._load();
}

require('util').inherits(FileAuthProvider, AuthProvider);

// Loaded once at construction, not re-read per call -- matches how
// --loadModule-sourced config is already treated elsewhere in this
// codebase (static for the life of the process; changing it requires a
// restart).
FileAuthProvider.prototype._load = function() {
  if (!fs.existsSync(this.configPath)) {
    // COUNTINGHOUSE_API_KEY alone is a complete, deliberate configuration
    // (see header comment) -- a missing file next to it isn't a first-run
    // gap to paper over with an unrelated, unused demo key.
    this.config = (this.envKey != null) ? {} : this._generateDemoConfig();
    return;
  }

  let raw;
  try {
    raw = fs.readFileSync(this.configPath, 'utf8');
  } catch (e) {
    LOG.E(new Error(`FileAuthProvider: failed to read ${this.configPath}: ${e.message}`));
    this.config = {};
    return;
  }

  try {
    this.config = JSON.parse(raw);
  } catch (e) {
    LOG.E(new Error(`FileAuthProvider: ${this.configPath} is not valid JSON: ${e.message}`));
    this.config = {};
  }
};

FileAuthProvider.prototype._generateDemoConfig = function() {
  const demoKey = `demo-${crypto.randomBytes(16).toString('hex')}`;
  const config = {};
  config[demoKey] = {userName: 'demo', devices: ['*']};

  try {
    fs.writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch (e) {
    LOG.E(new Error(`FileAuthProvider: failed to write demo config to ${this.configPath}: ${e.message}`));
  }

  console.log(`\n` +
    `============================================================\n` +
    `countinghouse: no ${this.configPath} found.\n` +
    `Generated a demo API key with access to every device --\n` +
    `replace it before any real deployment:\n` +
    `\n` +
    `  X-CH-Key: ${demoKey}\n` +
    `\n` +
    `Edit ${this.configPath} to add real keys, or set\n` +
    `COUNTINGHOUSE_API_KEY for single-key mode instead.\n` +
    `============================================================\n`);

  return config;
};

FileAuthProvider.prototype._lookup = function(apiKey) {
  if (apiKey == null) return null;
  if (this.envKey != null && apiKey === this.envKey) {
    // COUNTINGHOUSE_API_KEY is already a trusted, wildcard-device-access
    // bypass for the single-shared-key/container use case -- extending
    // that same trust to admin keeps it usable end-to-end for a minimal
    // deployment that only ever has this one key.
    return {userName: 'env-key-user', devices: ['*'], admin: true};
  }
  if (this.config[apiKey] == null) return null;
  const entry = this.config[apiKey];
  return {
    userName: entry.userName != null ? entry.userName : apiKey,
    devices:  Array.isArray(entry.devices) ? entry.devices : [],
    admin:    entry.admin === true
  };
};

FileAuthProvider.prototype.authenticate = function(apiKey, deviceID, serviceID, actionName, callback) {
  const entry = this._lookup(apiKey);
  if (entry == null) return callback(null, {ok: false, userName: null, isAdmin: false, err: new CHError('SYSTEM_ERROR_UNKNOWN_USER', apiKey)});

  if (deviceID != null) {
    const hasDevice = entry.devices.indexOf('*') !== -1 || entry.devices.indexOf(deviceID) !== -1;
    if (hasDevice !== true) return callback(null, {ok: false, userName: entry.userName, isAdmin: entry.admin, err: new CHError('USER_HAS_NO_DEVICE')});
  }

  return callback(null, {ok: true, userName: entry.userName, isAdmin: entry.admin, err: null});
};

FileAuthProvider.prototype.listDevices = function(apiKey, callback) {
  const entry = this._lookup(apiKey);
  return callback(null, {devices: entry != null ? entry.devices : []});
};

module.exports = FileAuthProvider;
