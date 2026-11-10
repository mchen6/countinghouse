// Default AuthProvider implementation (see provider.js): a flat JSON file,
// no external database required. Shape:
//
//   {
//     "<apiKey>": {"userName": "...", "devices": ["<deviceID>", ...], "admin": true,
//                  "runsModules": ["<friendlyName>", ...]}
//   }
//
// `runsModules` is optional and names the modules that run AS this identity
// when they compose (see AuthProvider.identityForModule). Absent on every
// pre-existing entry, which is why nothing needs migrating.
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
const jsonSyntaxWhere = require('../json-syntax-where');
const LOG     = require('../logger');
const safeEqual = require('./safe-equal').safeEqual;
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

// Loaded once at construction, not re-read per call; reload() (POST
// /reload-auth) re-reads it on the operator's command.
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
    LOG.E(new Error(`FileAuthProvider: ${this.configPath} is not valid JSON${jsonSyntaxWhere(e, raw)}`));
    this.config = {};
    return;
  }
  this._warnKeysAsNames(this.config);
  // Refused at startup (exit 2, framework.js): the server must not run with
  // two users sharing an id.
  checkIds(this.config, this.configPath, (message) => Object.assign(new Error(message), {code: 'AUTH_CONFIG_INVALID'}));
};

// The optional stable `id` of an entry (R2-1, lib/identity.js): a string of
// 1-128 printable characters, unique across the entries. Errors name entries
// by position, never by key.
const ID_FORM = /^[\x20-\x7e]{1,128}$/;
function checkIds(config, configPath, fail) {
  if (config == null || typeof(config) !== 'object') return;
  const seen = new Map();
  Object.keys(config).forEach((apiKey, i) => {
    const entry = config[apiKey];
    if (entry == null || typeof(entry) !== 'object' || entry.id == null) return;
    if (typeof(entry.id) !== 'string' || !ID_FORM.test(entry.id)) {
      throw fail(`entry #${i + 1} in ${configPath}: id must be a string of 1 to 128 printable characters`);
    }
    if (seen.has(entry.id)) throw fail(`${configPath}: entries ${seen.get(entry.id)} and ${i + 1} share id; every id must be unique`);
    seen.set(entry.id, i + 1);
  });
}

// User names are shown to callers -- a composite's bill (billedTo,
// authorizedAs), check_balance -- so a key that doubles as one is handed to
// every caller. Warns, once per entry at load, for an entry whose key equals
// its userName and for one with no userName (which _lookup falls back to the
// key for). Names the entry by position -- its user name here IS the key --
// and never prints a key; startup continues.
FileAuthProvider.prototype._warnKeysAsNames = function(config) {
  if (config == null || typeof(config) !== 'object') return;
  Object.keys(config).forEach((apiKey, i) => {
    const entry = config[apiKey];
    if (entry == null || typeof(entry) !== 'object') return;
    if (entry.userName == null) {
      LOG.W(`FileAuthProvider: entry #${i + 1} in ${this.configPath} has no userName, so its API key would be used as its user name. ` +
            'User names are shown to callers (bills, check_balance); add a userName.');
    } else if (entry.userName === apiKey) {
      LOG.W(`FileAuthProvider: entry #${i + 1} in ${this.configPath} uses its API key as its user name. ` +
            'User names are shown to callers (bills, check_balance), so give it a userName different from its key.');
    }
  });
};

// Read and check the file for reload(): the config it holds, or an error
// that names what is wrong by entry position, never by key. Stricter than
// the startup load (which takes an unreadable file as "no keys"), because a
// reload must never replace a working config with a broken one.
FileAuthProvider.prototype._readChecked = function() {
  const fail = (message) => Object.assign(new Error(message), {code: 'AUTH_RELOAD_INVALID'});
  let raw;
  try {
    raw = fs.readFileSync(this.configPath, 'utf8');
  } catch (e) {
    throw fail(`${this.configPath} could not be read (${e.code || e.message})`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    throw fail(`${this.configPath} is not valid JSON${jsonSyntaxWhere(e, raw)}`);
  }
  if (config == null || typeof(config) !== 'object' || Array.isArray(config)) throw fail(`${this.configPath} must hold an object of entries`);
  Object.keys(config).forEach((apiKey, i) => {
    const entry = config[apiKey];
    if (entry == null || typeof(entry) !== 'object' || Array.isArray(entry)) throw fail(`entry #${i + 1} in ${this.configPath} is not an object`);
    if (entry.devices != null && !Array.isArray(entry.devices)) throw fail(`entry #${i + 1} in ${this.configPath}: devices must be an array`);
  });
  checkIds(config, this.configPath, fail);
  return config;
};

// Every entry, for the identity index (lib/identity.js): the key, the name
// callers see, the admin flag, and the stable id when the entry has one.
FileAuthProvider.prototype.entries = function(callback) {
  const list = Object.keys(this.config).map((apiKey) => {
    const entry = this.config[apiKey] || {};
    return {apiKey: apiKey, userName: entry.userName != null ? entry.userName : apiKey, isAdmin: entry.admin === true, id: entry.id};
  });
  return callback(null, list);
};

// Swaps the config in one assignment, so a call sees either the old config
// or the new one, never a mix. A file that fails _readChecked leaves the old
// config in place. `changed` counts entries added, removed or modified.
FileAuthProvider.prototype.reload = function(callback) {
  let next;
  try {
    next = this._readChecked();
  } catch (e) {
    LOG.E(new Error(`FileAuthProvider: reload refused, keeping the current config: ${e.message}`));
    return callback(e);
  }
  const before = this.config || {};
  const keys = new Set(Object.keys(before).concat(Object.keys(next)));
  let changed = 0;
  keys.forEach((k) => { if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) changed++; });
  this.config = next;
  this._warnKeysAsNames(next);
  return callback(null, {ok: true, entries: Object.keys(next).length, changed: changed});
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
  if (typeof(apiKey) !== 'string') return null;
  if (this.envKey != null && safeEqual(apiKey, this.envKey)) {
    // COUNTINGHOUSE_API_KEY is already a trusted, wildcard-device-access
    // bypass for the single-shared-key/container use case -- extending
    // that same trust to admin keeps it usable end-to-end for a minimal
    // deployment that only ever has this one key.
    return {userName: 'env-key-user', devices: ['*'], admin: true};
  }
  // Own entries only: a key such as "constructor" or "__proto__" named an
  // Object.prototype member and authenticated (review R1-5).
  if (!Object.prototype.hasOwnProperty.call(this.config, apiKey) || this.config[apiKey] == null) return null;
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

// Scans entries rather than keeping an index: auth.json is loaded once at
// construction and is small, and an index would be a second thing to keep
// correct. COUNTINGHOUSE_API_KEY is deliberately not consulted -- it is a
// wildcard *caller* bypass, and making it an implicit composition identity
// for every module would grant inner hops nobody configured.
FileAuthProvider.prototype.identityForModule = function(friendlyName, callback) {
  const claimants = [];

  for (const apiKey in this.config) {
    const entry = this.config[apiKey];
    if (entry == null || !Array.isArray(entry.runsModules)) continue;
    if (entry.runsModules.indexOf(friendlyName) !== -1) claimants.push(apiKey);
  }

  if (claimants.length === 0) return callback(null, {apiKey: null, conflicts: null});
  if (claimants.length > 1)   return callback(null, {apiKey: null, conflicts: claimants});

  return callback(null, {apiKey: claimants[0], conflicts: null});
};

module.exports = FileAuthProvider;
