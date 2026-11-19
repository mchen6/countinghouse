// The auth provider's own failure text never reaches the caller (the
// back-sweep, 11-18): user-auth answered SYSTEM_ERROR_USERDB_NA with the
// provider's err.message, which can name a CouchDB or sqlite host or port,
// to a caller that may not even be authenticated. It answers with the
// catalogue's text now, and the detail goes to the log.
// Run in a child process: lib/auth is replaced in its require cache.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');

const LIB = path.join(__dirname, '..', '..', 'lib');

describe('auth 54: the auth provider\'s failure text stays in the log', function() {
  this.timeout(30000);

  it('a provider error answers SYSTEM_ERROR_USERDB_NA in the catalogue\'s words; the host and port are only in the log', () => {
    const script = `
      // the real lib/auth (its outage log), with a provider that fails
      const authPath = require.resolve(${JSON.stringify(path.join(LIB, 'auth'))});
      const realAuth = require(authPath);
      let up = false;
      const failing = realAuth.guarded({
        authenticate: (appKey, deviceID, serviceID, actionName, cb) => (up ? cb(null, {ok: true, userName: 'u', isAdmin: false})
          : cb(Object.assign(new Error('connect ECONNREFUSED couch.internal.example:5984'), {code: 'ECONNREFUSED'})))
      });
      require.cache[authPath].exports = Object.assign({}, realAuth, {getAuthProvider: () => failing});
      const logged = [];
      const LOG = require(${JSON.stringify(path.join(LIB, 'logger'))});
      const warned = [];
      LOG.E = (e) => logged.push(String(e && e.message));
      LOG.W = (w) => warned.push(String(w));
      const userAuth = require(${JSON.stringify(path.join(LIB, 'user-auth'))});
      const ask = () => new Promise((resolve) => userAuth(null, null, 'dev', 'some-key', 'svc', 'act', () => {}, (err) => resolve(err)));
      (async () => {
        const err = await ask();
        await ask();   // the same outage: not logged again
        up = true;
        await ask();   // it answers again: said once, with the count
        process.stdout.write('OUT ' + JSON.stringify({code: err && err.code, message: err && err.message, logged, warned}) + '\\n');
      })();`;
    const r = spawnSync(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 20000});
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
    assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
    const o = JSON.parse(line.slice(4));
    assert.strictEqual(o.code, 'SYSTEM_ERROR_USERDB_NA');
    assert.ok(!/couch\.internal|5984|ECONNREFUSED/.test(o.message), `the caller sees: ${o.message}`);
    assert.ok(o.logged.some((l) => /couch\.internal\.example:5984/.test(l)), `logged: ${JSON.stringify(o.logged)}`);
    // once per outage, never a line per request; and when it answers again,
    // how many failed meanwhile (the high review of #445, 6)
    assert.strictEqual(o.logged.length, 1, JSON.stringify(o.logged));
    assert.ok(o.warned.some((w) => /the auth provider answers again \(authenticate\): 2 lookups failed meanwhile/.test(w)), JSON.stringify(o.warned));
  });

  // The provider wrapped once (the second high review of #445, R2).
  it('the guard: one kind failing while another answers is said once; recovery only when the provider answers; the base identityForModule is left as it is', async () => {
    const auth = require(path.join(LIB, 'auth'));
    const LOG = require(path.join(LIB, 'logger'));
    const saved = {E: LOG.E, W: LOG.W};
    const logged = [];
    const warned = [];
    LOG.E = (e) => logged.push(String(e && e.message));
    LOG.W = (w) => warned.push(String(w));
    try {
      let listUp = false;
      let entriesCalls = 0;
      const raw = {
        authenticate: (k, d, s, a, cb) => cb(null, {ok: true}),
        listDevices: (k, cb) => (listUp ? cb(null, {devices: []}) : cb(new Error('view broken at couch.internal.example:5984'))),
        entries: (cb) => { entriesCalls++; cb(null, []); },
        identityForModule: auth.AuthProvider.prototype.identityForModule
      };
      const p = auth.guarded(raw);
      const ask = (fn) => new Promise((resolve) => fn((err, v) => resolve({err, v})));
      for (let i = 0; i < 3; i++) {
        const listed = await ask((cb) => p.listDevices('k', cb));
        assert.strictEqual(listed.err.code, 'SYSTEM_ERROR_USERDB_NA');
        assert.ok(!/couch\.internal/.test(listed.err.message), listed.err.message);
        const authed = await ask((cb) => p.authenticate('k', 'd', 's', 'a', cb));
        assert.strictEqual(authed.err, null);
      }
      assert.strictEqual(logged.length, 1, JSON.stringify(logged));
      assert.deepStrictEqual(warned, [], 'no recovery said for a kind that never failed');
      listUp = true;
      await ask((cb) => p.listDevices('k', cb));
      assert.ok(warned.length === 1 && /answers again \(listDevices\): 3 lookups failed meanwhile/.test(warned[0]), JSON.stringify(warned));
      // the identity lookup: answered from the index, the provider is not
      // asked, and nothing is said
      const identity = require(path.join(LIB, 'identity'));
      await ask((cb) => identity.resolve('nobody', p, cb));
      await ask((cb) => identity.resolve('nobody', p, cb));
      assert.ok(entriesCalls <= 1, `entries asked ${entriesCalls} times`);
      assert.strictEqual(warned.length, 1, JSON.stringify(warned));
      // device-manager tells an unsupported backend by the base's function
      assert.strictEqual(p.identityForModule, auth.AuthProvider.prototype.identityForModule);
      assert.ok(p instanceof Object && Object.getPrototypeOf(p) === Object.getPrototypeOf(raw));
    } finally {
      LOG.E = saved.E;
      LOG.W = saved.W;
    }
  });
});
