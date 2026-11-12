// The single-identity profile's AuthProvider (LM1, docs/superpowers/specs/
// 2026-11-11-local-mode-design.md section 4; plan 2026-11-11-lm1-store-and-
// identity.md, Task 7): --store local --stdio without --authConfigPath.
// A client machine has one user, who uses every tool the process hosts, so
// the multi-tenant path stays (the same access check, listing, metering and
// opaque caller id) and is fed one identity, held in memory only:
//
// - the key is the process's own (options.apiKey, made at start, never
//   printed, logged or written); any other is refused, without the key it
//   was given in the answer;
// - it may call every loaded device, and every loaded module runs as it
//   (ctx.call still needs the module's countinghouse.calls declaration);
// - its one entry has the stable id "local", so ctx.caller.id is derived
//   from the identity secret and "local", not the key: the id survives a
//   restart while the key changes;
// - it is not admin.
//
// Nothing is read or written: no auth file exists in this profile.
const util = require('util');
const AuthProvider = require('./provider');
const {CountinghouseError} = require('../countinghouse-error');

const USER_NAME = 'local';
const STABLE_ID = 'local';

function MemoryAuthProvider(opts) {
  AuthProvider.call(this);
  const o = opts || {};
  if (typeof(o.apiKey) !== 'string' || o.apiKey === '') throw new Error('MemoryAuthProvider needs the process\'s key');
  // not enumerable: the provider object never prints or serialises it
  Object.defineProperty(this, 'apiKey', {value: o.apiKey, enumerable: false});
}

util.inherits(MemoryAuthProvider, AuthProvider);

MemoryAuthProvider.prototype.authenticate = function(apiKey, deviceID, serviceID, actionName, callback) {
  if (apiKey !== this.apiKey) {
    return callback(null, {ok: false, userName: null, isAdmin: false, err: new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER')});
  }
  return callback(null, {ok: true, userName: USER_NAME, isAdmin: false, err: null});
};

MemoryAuthProvider.prototype.listDevices = function(apiKey, callback) {
  return callback(null, {devices: (apiKey === this.apiKey) ? ['*'] : []});
};

MemoryAuthProvider.prototype.identityForModule = function(friendlyName, callback) {
  return callback(null, {apiKey: this.apiKey, conflicts: null});
};

MemoryAuthProvider.prototype.entries = function(callback) {
  return callback(null, [{apiKey: this.apiKey, userName: USER_NAME, isAdmin: false, id: STABLE_ID}]);
};

MemoryAuthProvider.prototype.reload = function(callback) {
  return callback(null, {ok: true, entries: 1, changed: 0, note: 'the single-identity profile holds its one identity in memory'});
};

module.exports = MemoryAuthProvider;
