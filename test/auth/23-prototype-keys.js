// An API key is looked up by name in a plain object, so "constructor",
// "__proto__", "toString" and "hasOwnProperty" found Object.prototype's
// members and authenticated: a phantom tenant with its own session, rate
// limit and balance keys (review R1-5). Keys are now own entries only, and
// the environment key and --debugKey are compared in constant time.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileAuthProvider = require('../../lib/auth/file-provider');
const CouchDBAuthProvider = require('../../lib/couchdb-adapter/couchdb-auth-provider');
const {safeEqual} = require('../../lib/auth/safe-equal');

const PROTO_KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__'];
const auth = (provider, key, deviceID) => new Promise((resolve) => provider.authenticate(key, deviceID, null, null, (e, r) => resolve(r)));

describe('auth 23: keys that name Object.prototype members', () => {
  let dir = null;
  afterEach(() => { if (dir) fs.rmSync(dir, {recursive: true, force: true}); dir = null; });

  it('the file provider authenticates none of them, and a real key still works', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-auth-'));
    const configPath = path.join(dir, 'auth.json');
    fs.writeFileSync(configPath, JSON.stringify({'real-key': {userName: 'real', devices: ['*']}}));
    const provider = new FileAuthProvider({configPath: configPath});
    for (const key of PROTO_KEYS) {
      const r = await auth(provider, key, null);
      assert.strictEqual(r.ok, false, `${key} authenticated: ${JSON.stringify(r)}`);
      assert.deepStrictEqual(await new Promise((resolve) => provider.listDevices(key, (e, d) => resolve(d))), {devices: []});
    }
    assert.strictEqual((await auth(provider, 'real-key', null)).ok, true);
  });

  it('the CouchDB provider\'s cache answers none of them without asking the database', async () => {
    const provider = Object.create(CouchDBAuthProvider.prototype);
    provider._cache = new Map();
    provider.usersDB = {view: (d, v, q, cb) => cb(null, {rows: []})};
    for (const key of PROTO_KEYS) {
      const r = await auth(provider, key, null);
      assert.strictEqual(r.ok, false, `${key} authenticated: ${JSON.stringify(r)}`);
    }
  });

  it('safeEqual compares strings exactly', () => {
    assert.strictEqual(safeEqual('abc', 'abc'), true);
    ['abd', 'ab', 'abcd', '', null, undefined, 42].forEach((v) => assert.strictEqual(safeEqual('abc', v), false, String(v)));
    assert.strictEqual(safeEqual(null, null), false);
  });
});
