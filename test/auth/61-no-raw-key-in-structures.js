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
      await tick();
      // a call held in a batch, before its settle
      hub.callSucceeded({appKey: KEY, deviceID: 'd', serviceID: 'svc', serviceURN: 'urn:x:serviceID:svc', actionName: 'go', session: null});
      const open = hub.stateForTests();
      assert.ok(open.batches.length > 0, 'a batch is held');
      assert.deepStrictEqual(rawKeyPaths({scopes: open.scopes, batches: open.batches}, KEY), [], 'scopes and batches');
      assert.ok(open.scopes.includes(`k:${meterId(KEY)}`), JSON.stringify(open.scopes));
      // the open listener's own field is the one place the key is (the
      // stream's lifetime, as its session's): nowhere else in it
      assert.deepStrictEqual(rawKeyPaths(open.listeners, KEY).filter((p) => p !== '[0].appKey'), []);
      await tick(120);
      assert.ok(got.some((m) => m.method === 'notifications/resources/updated'), JSON.stringify(got));
      assert.ok(asked.length > 0 && asked.every((k) => k === KEY), 'the lists and the URIs are asked with the caller\'s key');
      // closed: the listener's key cleared, not just dropped with it
      const l = open.listeners[0];
      opened.close();
      assert.strictEqual(l.appKey, null, 'a closed listener keeps no key');
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
        lookup: (id) => (listed.has(id) ? {apiKey: listed.get(id), userName: null, isAdmin: false} : null)
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
      await tick(50);
      assert.ok(b.channelRegistry['61:62'] != null, 'a listed key still granted keeps its channel');
      revoked.add(KEY);
      b.recheckGrants();
      await tick(50);
      assert.strictEqual(b.channelRegistry['61:62'], undefined, 'a revoked key closes it');
    });

    it('an id the index no longer lists closes the channel (fails closed)', async () => {
      const {caller, callee} = workers(63, 64);
      const other = `${KEY}-gone`;
      const b = new PeerChannelBroker({deviceMap: {d: callee}});
      b.grant('d', other, caller, callee, ['svc|act']);
      b.recheckGrants();
      await tick(50);
      assert.strictEqual(b.channelRegistry['63:64'], undefined);
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
