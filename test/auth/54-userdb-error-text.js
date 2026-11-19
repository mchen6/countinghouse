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
      let t = 0;
      realAuth.resetOutagesForTests({now: () => t});
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
        t = 20000;     // past the quiet period
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
    let t = 0;
    auth.resetOutagesForTests({now: () => t});
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
      // within the quiet period: still open, nothing said (the high review
      // of #445, 2: a flapping provider is not opened and closed per request)
      await ask((cb) => p.listDevices('k', cb));
      assert.deepStrictEqual(warned, []);
      t += 20000;
      await ask((cb) => p.listDevices('k', cb));
      assert.ok(warned.length === 1 && /answers again \(listDevices\): 3 lookups failed meanwhile/.test(warned[0]), JSON.stringify(warned));
      assert.strictEqual(entriesCalls, 0);
      // device-manager tells an unsupported backend by the base's function
      assert.strictEqual(p.identityForModule, auth.AuthProvider.prototype.identityForModule);
      assert.ok(p instanceof Object && Object.getPrototypeOf(p) === Object.getPrototypeOf(raw));
      // a different reason in an outage still open is said too (the medium on
      // the second round, 2)
      listUp = false;
      await ask((cb) => p.listDevices('k', cb));
      raw.listDevices = (k, cb) => cb(new Error('another reason'));
      await ask((cb) => p.listDevices('k', cb));
      await ask((cb) => p.listDevices('k', cb));
      // and one said before in it is not said again
      raw.listDevices = (k, cb) => cb(new Error('view broken at couch.internal.example:5984'));
      await ask((cb) => p.listDevices('k', cb));
      assert.deepStrictEqual(logged.slice(1), ['view broken at couch.internal.example:5984', 'another reason']);
      // past REASONS_MAX (8) distinct reasons: counted, not said, and the
      // recovery line says how many
      for (let i = 0; i < 8; i++) {
        raw.listDevices = (k, cb) => cb(new Error(`reason ${i}`));
        await ask((cb) => p.listDevices('k', cb));
      }
      assert.strictEqual(logged.length, 1 + 8, JSON.stringify(logged));
      raw.listDevices = (k, cb) => cb(null, {devices: []});
      t += 20000;
      await ask((cb) => p.listDevices('k', cb));
      assert.match(warned[warned.length - 1], /answers again \(listDevices\): 12 lookups failed meanwhile; 2 with reasons past the first 8, not said/);
      // a reason as text, whatever it is (the high review of #445, 6 and 8)
      // a reason is never an object's JSON or a function's source: a driver's
      // object can carry its credentials (the high review of #448, 6)
      const driver = {host: 'db', credential: `cred-${process.pid}`, toString() { return this.credential; }};
      assert.deepStrictEqual([auth.reasonOf('down'), auth.reasonOf(driver), auth.reasonOf(() => 'source'), auth.reasonOf(undefined), auth.reasonOf(new Error(''))],
        ['down', '(no message)', '(no message)', '(no message)', '(no message)']);
      // an object's own code keeps two causes apart, and nothing else of it
      assert.deepStrictEqual([auth.reasonOf({code: 'ECONNREFUSED', credential: 'x'}), auth.reasonOf({code: 'EAUTH'}), auth.reasonOf({code: 'not a code'})],
        ['(no message; ECONNREFUSED)', '(no message; EAUTH)', '(no message)']);
      // a frozen lookup can't be guarded: refused at creation, not on each read
      assert.throws(() => auth.guarded(Object.freeze({authenticate: (k, d, s, a, cb) => cb(null, {ok: true})})), /frozen, so the runtime cannot guard it/);
      // another realm's Error keeps its message
      assert.strictEqual(auth.reasonOf(require('vm').runInNewContext('new Error("from a vm")')), 'from a vm');
      // an outage answered within the quiet period, then quiet, is over at
      // its next failure: said, and that failure starts a new one (the
      // medium on the fold, 1)
      raw.entries = (cb) => cb(new Error('entries down'));
      await ask((cb) => p.entries(cb));
      raw.entries = (cb) => cb(null, []);
      await ask((cb) => p.entries(cb));            // within the quiet period
      const quiet = warned.length;
      t += 60 * 60 * 1000;                          // an hour later
      raw.entries = (cb) => cb(new Error('entries down'));
      const loggedBefore = logged.length;
      await ask((cb) => p.entries(cb));
      assert.match(warned[quiet], /answers again \(entries\): 1 lookup failed meanwhile/, JSON.stringify(warned));
      assert.strictEqual(logged.length, loggedBefore + 1, 'the new outage says its reason');
      // a lookup the instance doesn't own is the class's, as patched now
      class Backend { authenticate(k, d, s, a, cb) { cb(null, {ok: 'old'}); } }
      const backend = auth.guarded(new Backend());
      Backend.prototype.authenticate = function(k, d, s, a, cb) { cb(null, {ok: 'new'}); };
      assert.strictEqual((await ask((cb) => backend.authenticate('k', 'd', 's', 'a', cb))).v.ok, 'new');
      assert.ok(backend instanceof Backend);
      // a provider that throws is answered the catalogue's words, its text in
      // the log only; a call with no callback is refused, never handed to the
      // provider; a throw from the caller's own callback is its own (the
      // final high review of #445, 4)
      raw.authenticate = () => { throw new Error('sync failure at couch.internal.example:5984'); };
      const thrown = await ask((cb) => p.authenticate('k', 'd', 's', 'a', cb));
      assert.strictEqual(thrown.err.code, 'SYSTEM_ERROR_USERDB_NA');
      assert.ok(!/couch\.internal/.test(thrown.err.message), thrown.err.message);
      assert.ok(logged.some((l) => /sync failure/.test(l)), JSON.stringify(logged));
      let reached = false;
      raw.listDevices = () => { reached = true; };
      const before = logged.length;
      assert.throws(() => p.listDevices('k'), TypeError);
      assert.strictEqual(reached, false);
      assert.strictEqual(logged.length, before, 'a caller\'s bug is no provider outage');
      // a provider that throws after starting its work is answered once
      let late = null;
      raw.authenticate = (k, d, s, a, cb) => { late = cb; throw new Error('thrown after starting'); };
      let answers = 0;
      p.authenticate('k', 'd', 's', 'a', () => { answers++; });
      late(new Error('the late answer'));
      late(null, {ok: true});
      assert.strictEqual(answers, 1, 'answered once');
      // an async provider's rejection is answered, never unhandled
      raw.authenticate = async () => { throw new Error('async failure at couch.internal.example:5984'); };
      const rejected = await ask((cb) => p.authenticate('k', 'd', 's', 'a', cb));
      assert.strictEqual(rejected.err.code, 'SYSTEM_ERROR_USERDB_NA');
      raw.listDevices = (k, cb) => cb(null, {devices: []});
      let calls = 0;
      assert.throws(() => p.listDevices('k', () => { calls++; throw new Error('the caller\'s own'); }), /the caller's own/);
      assert.strictEqual(calls, 1, 'answered once');
    } finally {
      LOG.E = saved.E;
      LOG.W = saved.W;
      auth.resetOutagesForTests();
    }
  });

  // In a fresh process: identity.resolve keeps module state (its last
  // refill), so an earlier file's resolve could leave entries unasked.
  it('identity.resolve: a refill is the provider answering; a cache hit and a refill within the minimum say nothing', () => {
    const script = `
      const auth = require(${JSON.stringify(path.join(LIB, 'auth'))});
      const LOG = require(${JSON.stringify(path.join(LIB, 'logger'))});
      const warned = [];
      const logged = [];
      LOG.W = (w) => warned.push(String(w));
      LOG.E = (e) => logged.push(String(e && e.message));
      let entriesCalls = 0;
      let up = false;
      const p = auth.guarded({entries: (cb) => { entriesCalls++; return up ? cb(null, []) : cb(new Error('entries down')); }});
      const identity = require(${JSON.stringify(path.join(LIB, 'identity'))});
      const resolve = () => new Promise((r) => identity.resolve('nobody', p, (err, found) => r({code: err && err.code, found})));
      (async () => {
        const first = await resolve();     // asks the provider: it fails
        const second = await resolve();    // within the minimum: not asked
        process.stdout.write('OUT ' + JSON.stringify({first, second, entriesCalls, warned, logged}) + '\\n');
      })();`;
    const r = spawnSync(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 20000});
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
    assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
    const o = JSON.parse(line.slice(4));
    assert.strictEqual(o.first.code, 'SYSTEM_ERROR_USERDB_NA');
    assert.deepStrictEqual(o.second, {code: null, found: null}, JSON.stringify(o));
    assert.strictEqual(o.entriesCalls, 1, 'the provider asked once');
    assert.deepStrictEqual(o.logged, ['entries down']);
    assert.deepStrictEqual(o.warned, [], 'no recovery said: the provider never answered');
  });
});
