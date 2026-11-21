'use strict';
// Default AuthProvider implementation (see provider.js): a flat JSON file,
// no external database required. Shape:
//
//   {
//     "<apiKey>": {"userName": "...", "devices": ["<deviceID>", ...], "admin": true,
//                  "runsModules": ["<module name>", ...]}
//   }
//
// `runsModules` is optional and names the modules (by the package.json name
// the server loads them under) that run AS this identity
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
//    set, a random demo key with wildcard access is generated and written
//    to auth.json, owner-only (so it survives a restart -- otherwise every
//    restart would invalidate whatever key was already handed out); the
//    file's path is printed, never the key (read it there). An *empty*
//    existing auth.json (`{}`) is left alone -- that's a deliberate "no one
//    is authorized yet" state, not a first-run.
//
// The file holds API keys in the clear: it is read only when it is this
// user's own, a regular file under one name, never through a link, mode
// 0600 (on Windows, its ACL: this user's alone), as lib/private-file.js
// judges the identity secret. Anything else refuses the start (exit 2) or
// the reload, naming the fix and never a key (B-meter-keys 4r).
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const jsonSyntaxWhere = require('../json-syntax-where');
const LOG     = require('../logger');
const safeEqual = require('./safe-equal').safeEqual;
const AuthProvider = require('./provider');
const privateFile = require('../private-file');
const {fixFor} = require('./private-store');

// The auth file as lib/private-file.js reads a private file (its form left
// to JSON.parse, which says where it is wrong). On Windows under
// --hardened, the parent checks it before the relaunch (prepareForHardened).
const AUTH_FILE = {what: 'the auth file', form: /^[\s\S]*$/, formText: 'JSON', maxBytes: 16 * 1024 * 1024, ownOnly: true,
  variable: 'COUNTINGHOUSE_AUTH_ACL_CHECKED'};
// The one spelling of the default path: the --hardened parent checks the
// file the child reads (framework.js), so the two must name it alike.
// (dir: the directory it is in, the process's working one unless given)
const defaultConfigPath = (dir = process.cwd()) => path.join(dir, 'auth.json');
// COUNTINGHOUSE_API_KEY, when set and not empty: a whole configuration alone
// (the start's load and the --hardened parent's create decide alike)
const envKeyOf = () => {
  const k = process.env.COUNTINGHOUSE_API_KEY;
  return (k != null && k !== '') ? k : null;
};
// -> the file's text, or null when it is not there; throws, with code, when
// it is not this user's own and owner-only
function readAuthFile(file, code) {
  // (lib/private-file.js says what a refusal is about: its fix is named)
  const spec = Object.assign({}, AUTH_FILE, {refuse: (message, kind) => Object.assign(new Error(`${message}${fixFor(kind, file)}`), {code})});
  return privateFile.readChecked(file, spec, {settle: false});
}

function FileAuthProvider(opts) {
  AuthProvider.call(this);
  opts = opts || {};

  this.configPath = opts.configPath || defaultConfigPath();
  this.envKey = envKeyOf();
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
    if (this.envKey != null) { this.config = {}; return; }
    // (under --hardened on Windows the parent makes it before the relaunch;
    // this child can't: no PowerShell for its ACL)
    if (process.platform === 'win32' && process.permission != null) {
      throw privateFile.refuseAbsentUnderHardened(this.configPath, Object.assign({}, AUTH_FILE, {refuse: (message) => Object.assign(new Error(message), {code: 'AUTH_CONFIG_INVALID'})}));
    }
    this.config = this._generateDemoConfig();
    return;
  }

  // (not this user's own and owner-only: the start is refused, exit 2)
  const raw = readAuthFile(this.configPath, 'AUTH_CONFIG_INVALID');
  if (raw == null) {
    this.config = (this.envKey != null) ? {} : this._generateDemoConfig();
    return;
  }

  this.config = this._parsed(raw);
};

// The startup load's parse (and the config another start wrote first,
// _loadWritten): JSON it can't parse is logged and holds no keys; two
// entries with one id are refused (exit 2, framework.js): the server must
// not run with two users sharing an id.
FileAuthProvider.prototype._parsed = function(raw) {
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    LOG.E(new Error(`FileAuthProvider: ${this.configPath} is not valid JSON${jsonSyntaxWhere(e, raw)}`));
    return {};
  }
  this._warnKeysAsNames(config);
  checkIds(config, this.configPath, (message) => Object.assign(new Error(message), {code: 'AUTH_CONFIG_INVALID'}));
  return config;
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
// its userName and for one with no userName (which callers see unnamed).
// Names the entry by position -- its user name here IS the key -- and never
// prints a key; startup continues.
FileAuthProvider.prototype._warnKeysAsNames = function(config) {
  if (config == null || typeof(config) !== 'object') return;
  Object.keys(config).forEach((apiKey, i) => {
    const entry = config[apiKey];
    if (entry == null || typeof(entry) !== 'object') return;
    if (entry.userName == null) {
      LOG.W(`FileAuthProvider: entry #${i + 1} in ${this.configPath} has no userName, so callers see no user name. ` +
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
  // Under --hardened on Windows the file's ACL is checked only by the parent,
  // before the relaunch (no PowerShell here): a reload can't check it, so it
  // is refused, never read unchecked; a restart applies the change.
  if (process.platform === 'win32' && process.permission != null) {
    throw fail(`${this.configPath}'s ACL cannot be checked by a reload under --hardened on Windows; restart countinghouse to apply the change`);
  }
  // (as the start reads it: this user's own and owner-only)
  const raw = readAuthFile(this.configPath, 'AUTH_RELOAD_INVALID');
  if (raw == null) throw fail(`${this.configPath} could not be read (ENOENT)`);
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
    return {apiKey: apiKey, userName: entry.userName != null ? entry.userName : null, isAdmin: entry.admin === true, id: entry.id};
  });
  return callback(null, list);
};

// Every device ID a grant names, '*' aside: no key, no user (lib/pre-8-device-ids.js,
// removed after release 1). callback(null, [deviceID]).
FileAuthProvider.prototype.grantedDeviceIDs = function(callback) {
  const ids = new Set();
  for (const apiKey of Object.keys(this.config)) {
    const devices = (this.config[apiKey] || {}).devices;
    if (Array.isArray(devices)) for (const d of devices) if (typeof(d) === 'string' && d !== '*') ids.add(d);
  }
  return callback(null, [...ids]);
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

// The demo key, written owner-only (lib/private-file.js createPrivate: 0600,
// on Windows this user's ACL alone), never printed: its file's path is.
// -> {config, written}: written false when another start wrote the file
// first (its config is that file's). A write that fails throws: no key
// anyone was told of, and the start is refused rather than run keyless.
function writeDemoConfig(configPath) {
  const demoKey = `demo-${crypto.randomBytes(16).toString('hex')}`;
  const config = {};
  config[demoKey] = {userName: 'demo', devices: ['*']};
  const spec = Object.assign({}, AUTH_FILE, {refuse: (message) => Object.assign(new Error(message), {code: 'AUTH_CONFIG_INVALID'})});
  let written;
  try {
    written = privateFile.createPrivate(path.dirname(configPath), configPath, `${JSON.stringify(config, null, 2)}\n`, spec, '--authConfigPath');
  } catch (e) {
    throw Object.assign(new Error(`FileAuthProvider: failed to write the demo config to ${configPath}: ${e.message}`), {code: 'AUTH_CONFIG_INVALID'});
  }
  if (written !== true) return {config: null, written: false};

  console.log(`\n` +
    `============================================================\n` +
    `countinghouse: no ${configPath} found.\n` +
    `Generated a demo API key with access to every device, written to\n` +
    `${configPath} (readable by you only); the key is not printed.\n` +
    `Read it there, and replace it before any real deployment.\n` +
    `\n` +
    `Edit ${configPath} to add real keys (keep it mode 0600), or set\n` +
    `COUNTINGHOUSE_API_KEY for single-key mode instead.\n` +
    `============================================================\n`);
  return {config, written: true};
}

FileAuthProvider.prototype._generateDemoConfig = function() {
  const made = writeDemoConfig(this.configPath);
  // (another start wrote it first: that file is the config)
  return made.written ? made.config : this._loadWritten();
};

// The config another start wrote while this one made its demo file.
FileAuthProvider.prototype._loadWritten = function() {
  const raw = readAuthFile(this.configPath, 'AUTH_CONFIG_INVALID');
  return raw != null ? this._parsed(raw) : {};
};

// On Windows under --hardened the relaunched server can't run the PowerShell
// the ACL check needs: the parent checks the auth file first, as it does the
// identity secret (framework.js; lib/private-file.js prepareForHardened). A
// file not there is made here, the demo config, as the child can't make one
// (no PowerShell for its ACL); none beside COUNTINGHOUSE_API_KEY, which is a
// whole configuration alone (as _load).
FileAuthProvider.prepareForHardened = function(configPath) {
  const spec = Object.assign({}, AUTH_FILE, {refuse: (message) => Object.assign(new Error(message), {code: 'AUTH_CONFIG_INVALID'})});
  privateFile.prepareForHardened(configPath, spec, {
    create: () => (envKeyOf() != null ? false : void writeDemoConfig(configPath)),
    check: () => { readAuthFile(configPath, 'AUTH_CONFIG_INVALID'); }
  });
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
    // (an entry with no userName has none -- as entries() says and the
    // sqlite store answers -- never its key: a user name is shown to
    // callers, bills and check_balance)
    userName: entry.userName != null ? entry.userName : null,
    devices:  Array.isArray(entry.devices) ? entry.devices : [],
    admin:    entry.admin === true
  };
};

FileAuthProvider.prototype.authenticate = function(apiKey, deviceID, serviceID, actionName, callback) {
  const entry = this._lookup(apiKey);
  if (entry == null) return callback(null, {ok: false, userName: null, isAdmin: false, err: new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER')});

  if (deviceID != null) {
    const hasDevice = entry.devices.indexOf('*') !== -1 || entry.devices.indexOf(deviceID) !== -1;
    if (hasDevice !== true) return callback(null, {ok: false, userName: entry.userName, isAdmin: entry.admin, err: new CountinghouseError('USER_HAS_NO_DEVICE')});
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
FileAuthProvider.prototype.identityForModule = function(moduleName, callback) {
  const claimants = [];

  for (const apiKey in this.config) {
    const entry = this.config[apiKey];
    if (entry == null || !Array.isArray(entry.runsModules)) continue;
    if (entry.runsModules.indexOf(moduleName) !== -1) claimants.push(apiKey);
  }

  if (claimants.length === 0) return callback(null, {apiKey: null, conflicts: null});
  if (claimants.length > 1)   return callback(null, {apiKey: null, conflicts: claimants});

  return callback(null, {apiKey: claimants[0], conflicts: null});
};

FileAuthProvider.defaultConfigPath = defaultConfigPath;

module.exports = FileAuthProvider;
