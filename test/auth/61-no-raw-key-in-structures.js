// C-meter-keys-3 (CLAUDE.md: a raw API key never goes into a Map key or
// long-lived structure; key by its meterId): the main thread's structures
// that held a key -- the subscriptions hub's scopes, batches and views, the
// peer channel broker's grant records, and the CouchDB provider's cache --
// are dumped after a call, and no raw key is in them. (The completion floor
// and its running count: mcp-contract 30.)
const assert = require('assert');
const {rawKeyPaths} = require('../helpers/no-raw-key');
const {meterId} = require('../../lib/key-fingerprint');

const KEY = 'test-raw-key-0123456789abcdef-invalid';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
// (a bound on something observable, never a fixed wait)
const until = async (f, what) => { for (let i = 0; i < 1000 && !f(); i++) await tick(5); assert.ok(f(), what); };

describe('auth 61: no raw API key in the main thread\'s structures (C-meter-keys-3)', function() {
  this.timeout(30000);

  describe('the subscriptions hub', () => {
    const {createHub} = require('../../lib/mcp/subscriptions');

    it('scopes, batches and views are its meterId; a listener closed holds no key', async () => {
      const asked = [];
      const hub = createHub({
        lists: {tools: async (k) => { asked.push(k); return [{name: 'a'}]; }},
        resolveUris: async (k, session, uris) => { asked.push(k); return new Map(uris.map((u) => [u, {deviceID: 'd', changesWith: ['svc.go']}])); },
        settleMs: 50
      });
      const got = [];
      const opened = hub.open({id: 1, appKey: KEY, filter: {toolsListChanged: true, resourceSubscriptions: ['r://one']}, write: (m) => got.push(m), finish: () => {}});
      assert.strictEqual(opened.ok, true);
      await until(() => asked.length > 0, 'its lists asked');
      // a call held in a batch, before its settle
      hub.callSucceeded({appKey: KEY, deviceID: 'd', serviceID: 'svc', serviceURN: 'urn:x:serviceID:svc', actionName: 'go', session: null});
      const open = hub.stateForTests();
      assert.ok(open.batches.length > 0, 'a batch is held');
      assert.deepStrictEqual(rawKeyPaths({scopes: open.scopes, batches: open.batches}, KEY), [], 'scopes and batches');
      assert.ok(open.scopes.includes(`k:${meterId(KEY)}`), JSON.stringify(open.scopes));
      // the open listener's own field is the one place the key is (the
      // stream's lifetime, as its session's): nowhere else in it
      assert.deepStrictEqual(rawKeyPaths(open.listeners, KEY).filter((p) => p !== '[0].appKey'), []);
      await until(() => got.some((m) => m.method === 'notifications/resources/updated'), 'the notice');
      assert.ok(asked.length > 0 && asked.every((k) => k === KEY), 'the lists and the URIs are asked with the caller\'s key');
      // closed: the listener's key cleared, not just dropped with it, and
      // the gateway's closures that hold it too
      const l = open.listeners[0];
      opened.close();
      assert.strictEqual(l.appKey, null, 'a closed listener keeps no key');
      assert.deepStrictEqual([l.write, l.finish, l.taskView], [null, null, null], 'nor its closures');
      assert.deepStrictEqual(rawKeyPaths(l, KEY), []);
      assert.deepStrictEqual(rawKeyPaths(hub.stateForTests(), KEY), []);
    });

    it('the per-key limit still counts a key\'s listeners, by its meterId', () => {
      const hub = createHub({listTools: async () => [], maxPerKey: 1});
      const one = hub.open({id: 1, appKey: KEY, filter: {toolsListChanged: true}, write: () => {}, finish: () => {}});
      assert.strictEqual(one.ok, true);
      assert.deepStrictEqual(hub.open({id: 2, appKey: KEY, filter: {toolsListChanged: true}, write: () => {}, finish: () => {}}), {ok: false, reason: 'key'});
      assert.strictEqual(hub.open({id: 3, appKey: `${KEY}-other`, filter: {toolsListChanged: true}, write: () => {}, finish: () => {}}).ok, true);
      assert.strictEqual(hub.count(KEY), 1);
      one.close();
    });
  });

  describe('the peer channel broker', () => {
    const cli = require('../../lib/cli-options');
    const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
    let kept = null;
    let PeerChannelBroker = null;
    const authPath = require.resolve('../../lib/user-auth');
    const brokerPath = require.resolve('../../lib/peer-channel-broker');
    const idPath = require.resolve('../../lib/identity');
    let saved = null;
    let revoked = null;
    let listed = null;
    before(() => {
      kept = optionsNow();
      cli.setOptions({workerThread: true, peerChannelAuthRecheckSeconds: 0, peerChannelAuthLookupTimeoutMs: 500});
      require('../../lib/logger').createLogger();
      saved = {auth: require.cache[authPath], id: require.cache[idPath]};
      revoked = new Set();
      listed = new Map();   // id -> key, as the identity index holds it
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
        exports: (a, b, deviceID, appKey, c, d, localCB, cb) => setImmediate(() => cb(revoked.has(appKey) ? Object.assign(new Error('revoked'), {code: 'USER_HAS_NO_DEVICE'}) : null))};
      require.cache[idPath] = {id: idPath, filename: idPath, loaded: true, exports: Object.assign({}, require('../../lib/identity'), {
        idForKey: (k) => `u_${meterId(k).slice(7, 29)}`,
        lookup: (id) => (listed.has(id) ? {apiKey: listed.get(id), userName: null, isAdmin: false} : null),
        resolve: (id, provider, cb) => cb(null, listed.has(id) ? {apiKey: listed.get(id), userName: null, isAdmin: false} : null)
      })};
      delete require.cache[brokerPath];
      PeerChannelBroker = require('../../lib/peer-channel-broker');
    });
    after(() => {
      for (const [p, m] of [[authPath, saved.auth], [idPath, saved.id]]) { if (m != null) require.cache[p] = m; else delete require.cache[p]; }
      delete require.cache[brokerPath];
      restoreOptions(kept);
    });
    const workers = (a, b) => ({
      callee: {workerId: b, ended: null, unloading: false, sendPeerChannelOpenToChild: () => {}, sendPeerChannelAllowToChild: (m, cb) => cb(null), sendPeerInvalidateToChild: () => {}},
      caller: {workerId: a, ended: null, unloading: false, sendPeerChannelGrantToChild: () => {}, sendPeerInvalidateToChild: () => {}}
    });

    it('a grant record names the caller by id and holds no key; the re-check finds the key by the id', async () => {
      const {caller, callee} = workers(61, 62);
      const id = `u_${meterId(KEY).slice(7, 29)}`;
      listed.set(id, KEY);
      const b = new PeerChannelBroker({deviceMap: {d: callee}});
      b.grant('d', KEY, caller, callee, ['svc|act']);
      b.grant('d2', KEY, caller, callee, ['svc|act']);
      assert.deepStrictEqual(rawKeyPaths(b.channelRegistry, KEY, {skip: (v) => v === caller || v === callee}), []);
      b.recheckGrants();
      await until(() => b.recheckInFlight === 0, 'the re-check done');
      assert.ok(b.channelRegistry['61:62'] != null, 'a listed key still granted keeps its channel');
      revoked.add(KEY);
      b.recheckGrants();
      await until(() => b.channelRegistry['61:62'] === undefined, 'a revoked key closes it');
    });

    it('an id the index no longer lists closes the channel (fails closed)', async () => {
      const {caller, callee} = workers(63, 64);
      const other = `${KEY}-gone`;
      const b = new PeerChannelBroker({deviceMap: {d: callee}});
      b.grant('d', other, caller, callee, ['svc|act']);
      b.recheckGrants();
      await until(() => b.channelRegistry['63:64'] === undefined, 'closed');
    });
  });

  // --debug outside the single-identity profile has no provider: the
  // identity index remembers the keys it is given for this process, at most
  // its cap, the first given out first (B-meter-keys (2)). A channel whose
  // key is let go is closed at the re-check, with that reason and never the
  // key; the caller's next request makes the key known again and reopens it.
  describe('the peer channel broker, --debug with no provider: a key past those remembered', () => {
    const cli = require('../../lib/cli-options');
    const identity = require('../../lib/identity');
    const LOG = require('../../lib/logger');
    const tmp = require('../helpers/test-tmp');
    const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
    const authPath = require.resolve('../../lib/user-auth');
    const brokerPath = require.resolve('../../lib/peer-channel-broker');
    let kept = null;
    let savedAuth = null;
    let savedIdentity = null;
    let dir = null;
    let PeerChannelBroker = null;
    before(() => {
      kept = optionsNow();
      cli.setOptions({workerThread: true, debug: true, singleIdentity: false, peerChannelAuthRecheckSeconds: 0, peerChannelAuthLookupTimeoutMs: 2000});
      LOG.createLogger();
      savedAuth = require.cache[authPath];
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: (a, b, deviceID, appKey, c, d, localCB, cb) => setImmediate(() => cb(null))};
      delete require.cache[brokerPath];
      PeerChannelBroker = require('../../lib/peer-channel-broker');
      savedIdentity = identity.stateForTests();
      dir = tmp.mkdtemp('ch-auth61-');
      identity.initSync({moduleDataPath: dir});
    });
    after(() => {
      if (savedIdentity != null) identity.restoreForTests(savedIdentity);
      if (dir != null) tmp.remove(dir);
      if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
      delete require.cache[brokerPath];
      restoreOptions(kept);
    });

    it('closed at the re-check with its reason, never the key; known again, it reopens', async () => {
      assert.strictEqual(require('../../lib/auth').identitySource(cli), null, 'no provider');
      const lines = [];
      const savedI = LOG.I;
      LOG.I = (m) => { lines.push(String(m)); return m; };
      try {
        const grantFor = (b) => {
          const callee = {workerId: 66, ended: null, unloading: false, sendPeerChannelOpenToChild: () => {}, sendPeerInvalidateToChild: () => {}};
          const caller = {workerId: 65, ended: null, unloading: false, sendPeerChannelGrantToChild: () => {}, sendPeerInvalidateToChild: () => {}};
          b.grant('d', KEY, caller, callee, ['svc|act']);
        };
        const b = new PeerChannelBroker({deviceMap: {}});
        await identity.know(KEY, null);
        grantFor(b);
        b.recheckGrants();
        await until(() => b.recheckInFlight === 0, 'the re-check done');
        assert.ok(b.channelRegistry['65:66'] != null, 'remembered: kept');
        // more keys than the index remembers: the first given goes
        for (let i = 0, gone = false; !gone; i++) {
          assert.ok(i < 100000, 'the index let no key go');
          identity.addKey(`test-fill-${i}-invalid`, null, false);
          gone = identity.lookup(identity.idForKey(KEY)) == null;
        }
        b.recheckGrants();
        await until(() => b.channelRegistry['65:66'] === undefined, 'closed');
        const closedLine = lines.find((l) => l.includes('peer channel 65:66 closed'));
        assert.ok(closedLine != null, JSON.stringify(lines));
        assert.ok(closedLine.includes('its key is no longer held: past the keys this process remembers without a provider'), closedLine);
        assert.ok(!closedLine.includes(KEY), closedLine);
        // the next request makes it known again (the broker's grant does,
        // composition 18), and the channel holds
        await identity.know(KEY, null);
        grantFor(b);
        b.recheckGrants();
        await until(() => b.recheckInFlight === 0, 'the re-check done');
        assert.ok(b.channelRegistry['65:66'] != null, 'reopened');
      } finally {
        LOG.I = savedI;
      }
    });
  });

  describe('the CouchDB provider\'s cache', () => {
    const CouchDBAuthProvider = require('../../lib/couchdb-adapter/couchdb-auth-provider');
    const provider = (asked) => {
      const p = Object.create(CouchDBAuthProvider.prototype);
      p._cache = new Map();
      p.usersDB = {view: (d, v, q, cb) => { asked.push(q.key); cb(null, {rows: [{key: q.key, value: ['someone', null, [{deviceID: 'd'}], false]}]}); }};
      return p;
    };

    it('is keyed by the key\'s meterId, and still answers from it', async () => {
      const asked = [];
      const p = provider(asked);
      const auth = () => new Promise((resolve, reject) => p.authenticate(KEY, 'd', null, null, (e, r) => (e ? reject(e) : resolve(r))));
      assert.strictEqual((await auth()).ok, true);
      assert.strictEqual((await auth()).ok, true);
      assert.strictEqual(asked.length, 1, 'the second answered from the cache');
      assert.deepStrictEqual(rawKeyPaths(p._cache, KEY), []);
      assert.ok(p._cache.has(meterId(KEY)));
    });

    it('is bounded: past its cap the least recently used goes', async () => {
      const asked = [];
      const p = provider(asked);
      const cap = CouchDBAuthProvider.CACHE_MAX;
      assert.ok(Number.isInteger(cap) && cap > 0, 'a cap');
      for (let i = 0; i <= cap; i++) await new Promise((r) => p._lookup(`k-${i}`, r));
      assert.strictEqual(p._cache.size, cap);
      assert.strictEqual(p._cache.has(meterId('k-0')), false, 'the oldest went');
    });
  });
});
