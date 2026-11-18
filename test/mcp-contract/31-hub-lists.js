'use strict';
// M8 (MCP completeness spec, sections 3 and 7), server free: the listen hub
// (lib/mcp/subscriptions.js) with lists and URI resolutions the test sets.
// notifications/resources/list_changed and notifications/prompts/list_changed
// are sent as tools/list_changed is: once a settled change moves a list the
// listener agreed to. notifications/resources/updated goes to a
// subscription naming a URI whose resource lists the successful call's
// action in changesWith: only the calling key's listeners, each resolving the
// URI in its own view, and on the shared runtime a per-session module's only
// to the calling session's.
const assert = require('assert');
const {createHub, SUBSCRIPTION_ID_KEY} = require('../../lib/mcp/subscriptions');

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 3000) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await tick(10);
  return test();
};
const U1 = 'countinghouse://m/notes/notes/1';
const U2 = 'countinghouse://m/notes/notes/2';
const methods = (got) => got.map((m) => m.method);

describe('M8: the listen hub, resources and prompts', function() {
  this.timeout(10000);
  let lists;
  let views;
  let perSessionDevices;
  let resolved;
  let hub;
  beforeEach(() => {
    lists = {tools: [{name: 'a'}], resources: [{uri: U1}], resourceTemplates: [{uriTemplate: 'countinghouse://m/notes/notes/{id}'}], prompts: [{name: 'p'}]};
    // a listener's view: (key, session) -> uri -> {deviceID, changesWith}
    views = {};
    perSessionDevices = new Set();
    resolved = [];
    hub = createHub({
      lists: {
        tools: async() => lists.tools,
        resources: async() => lists.resources,
        resourceTemplates: async() => lists.resourceTemplates,
        prompts: async() => lists.prompts
      },
      resolveUris: async(appKey, session, uris) => {
        resolved.push([appKey, session, uris.slice()]);
        const view = views[`${appKey}|${session}`] || {};
        const out = new Map();
        for (const uri of uris) if (view[uri] != null) out.set(uri, view[uri]);
        return out;
      },
      perSession: (deviceID) => perSessionDevices.has(deviceID),
      settleMs: 5
    });
  });
  const listener = (id, filter, key = 'k', session = null) => {
    const got = [];
    const opened = hub.open({id, appKey: key, session, filter, write: (m) => got.push(m), finish: () => {}});
    return {got, opened};
  };
  const see = (key, session, uri, deviceID, changesWith) => {
    views[`${key}|${session}`] = Object.assign(views[`${key}|${session}`] || {}, {[uri]: {deviceID, changesWith}});
  };

  describe('list_changed', () => {
    it('a change to the resources, or to the templates, sends one resources/list_changed with the subscription id; the same lists send none', async() => {
      const l = listener(7, {resourcesListChanged: true});
      await tick();
      hub.changed();
      await tick(40);
      assert.deepStrictEqual(l.got, [], 'the same lists: nothing');
      lists.resources = [{uri: U1}, {uri: U2}];
      hub.changed();
      assert.ok(await until(() => l.got.length === 1));
      assert.deepStrictEqual(l.got[0], {jsonrpc: '2.0', method: 'notifications/resources/list_changed', params: {_meta: {[SUBSCRIPTION_ID_KEY]: 7}}});
      lists.resourceTemplates = [];
      hub.changed();
      assert.ok(await until(() => l.got.length === 2));
      assert.strictEqual(l.got[1].method, 'notifications/resources/list_changed');
    });

    it('a change to the prompts sends one prompts/list_changed', async() => {
      const l = listener(8, {promptsListChanged: true});
      await tick();
      lists.prompts = [{name: 'p'}, {name: 'q'}];
      hub.changed();
      assert.ok(await until(() => l.got.length === 1));
      assert.deepStrictEqual(l.got[0], {jsonrpc: '2.0', method: 'notifications/prompts/list_changed', params: {_meta: {[SUBSCRIPTION_ID_KEY]: 8}}});
    });

    it('each list is notified to the listeners that agreed to it, and only when it moved', async() => {
      const tools = listener(1, {toolsListChanged: true});
      const resources = listener(2, {resourcesListChanged: true});
      const all = listener(3, {toolsListChanged: true, resourcesListChanged: true, promptsListChanged: true});
      await tick();
      lists.tools = [{name: 'b'}];
      lists.prompts = [];
      hub.changed();
      assert.ok(await until(() => all.got.length === 2));
      await tick(40);
      assert.deepStrictEqual(methods(tools.got), ['notifications/tools/list_changed']);
      assert.deepStrictEqual(resources.got, []);
      assert.deepStrictEqual(methods(all.got).sort(), ['notifications/prompts/list_changed', 'notifications/tools/list_changed']);
    });

    it('listTools alone still makes a hub of tools (the earlier signature)', async() => {
      let tools = [{name: 'a'}];
      const h = createHub({listTools: async() => tools, settleMs: 5});
      const got = [];
      h.open({id: 1, appKey: 'k', filter: {toolsListChanged: true}, write: (m) => got.push(m), finish: () => {}});
      await tick();
      tools = [{name: 'b'}];
      h.changed();
      assert.ok(await until(() => got.length === 1));
      assert.strictEqual(got[0].method, 'notifications/tools/list_changed');
    });
  });

  // F3-2 and F3-7 (the Fable pass over the MCP surface)
  describe('the hub\'s bounds', () => {
    it('one listener whose list can\'t be compared never silences the next one\'s (F3-2)', async() => {
      // key "bad" lists an item no JSON can carry (a BigInt): its fingerprint threw, and the round with it
      let tools = {bad: [{name: 'a'}], good: [{name: 'a'}]};
      const h = createHub({lists: {tools: async(key) => tools[key]}, settleMs: 5});
      const bad = [];
      const good = [];
      h.open({id: 1, appKey: 'bad', filter: {toolsListChanged: true}, write: (m) => bad.push(m), finish: () => {}});
      h.open({id: 2, appKey: 'good', filter: {toolsListChanged: true}, write: (m) => good.push(m), finish: () => {}});
      await tick();
      tools = {bad: [{name: 'a', n: 1n}], good: [{name: 'b'}]};
      h.changed();
      assert.ok(await until(() => good.length === 1), 'the next listener is told');
      assert.deepStrictEqual(bad, [], 'and the one that can\'t be compared is told nothing');
    });

    it('an item moved within a list says nothing; a changed item says once (fingerprints by item, F3-2)', async() => {
      let tools = [{name: 'a', x: 'y'.repeat(100000)}, {name: 'b'}];
      const h = createHub({lists: {tools: async() => tools}, settleMs: 5});
      const got = [];
      h.open({id: 1, appKey: 'k', filter: {toolsListChanged: true}, write: (m) => got.push(m), finish: () => {}});
      await tick();
      tools = [tools[1], tools[0]];
      h.changed();
      await tick(60);
      assert.deepStrictEqual(got, []);
      tools = [tools[0], {name: 'a', x: 'z'.repeat(100000)}];
      h.changed();
      assert.ok(await until(() => got.length === 1));
    });

    it('an icon\'s data counts by its digest: the same data says nothing, other data says once (F3-2)', async() => {
      const icon = (fill) => [{src: `data:image/png;base64,${fill.repeat(200000)}`, mimeType: 'image/png'}];
      let tools = [{name: 'a', icons: icon('A')}];
      const h = createHub({lists: {tools: async() => tools}, settleMs: 5});
      const got = [];
      h.open({id: 1, appKey: 'k', filter: {toolsListChanged: true}, write: (m) => got.push(m), finish: () => {}});
      await tick();
      tools = [{name: 'a', icons: icon('A')}];
      h.changed();
      await tick(60);
      assert.deepStrictEqual(got, [], 'the same icon, a new string');
      tools = [{name: 'a', icons: icon('B')}];
      h.changed();
      assert.ok(await until(() => got.length === 1), 'another icon');
    });

    it('a round never starts while the last one runs; the one due meanwhile runs after it (F3-7)', async() => {
      let tools = [{name: 'a'}];
      let running = 0;
      let most = 0;
      let rounds = 0;
      const h = createHub({lists: {tools: async() => {
        running += 1; most = Math.max(most, running); rounds += 1;
        await tick(150);
        running -= 1;
        return tools;
      }}, settleMs: 5, maxWaitMs: 20});
      const got = [];
      h.open({id: 1, appKey: 'k', filter: {toolsListChanged: true}, write: (m) => got.push(m), finish: () => {}});
      await tick(200);
      tools = [{name: 'b'}];
      for (let i = 0; i < 20; i++) { h.changed(); await tick(25); }
      await tick(600);
      assert.strictEqual(most, 1, 'never two rounds listing at once');
      assert.strictEqual(got.length, 1, 'one change, one notice');
    });

    it('changes coming faster than the settle postpone the round no further than the max wait (F3-7)', async() => {
      let tools = [{name: 'a'}];
      const h = createHub({lists: {tools: async() => tools}, settleMs: 100, maxWaitMs: 300});
      let start = null;
      let toldAt = null;
      // (timed where it is told, not where the loop next looks)
      h.open({id: 1, appKey: 'k', filter: {toolsListChanged: true}, write: () => { if (toldAt == null) toldAt = Date.now() - start; }, finish: () => {}});
      await tick();
      tools = [{name: 'b'}];
      start = Date.now();
      // a change every 40 ms for 2 s: each inside the settle of the last
      while (Date.now() - start < 2000) {
        h.changed({session: 'flipper'});
        h.changed();
        await tick(40);
      }
      assert.ok(toldAt != null && toldAt < 1500, `told within the max wait (300 ms), not after the flipping stopped at 2 s (${toldAt} ms)`);
    });
  });

  describe('resources/updated', () => {
    const called = (appKey, deviceID, serviceID, actionName, session = null) => hub.callSucceeded({appKey, deviceID, serviceID, actionName, session});
    const updated = (id, uri) => ({jsonrpc: '2.0', method: 'notifications/resources/updated', params: {uri, _meta: {[SUBSCRIPTION_ID_KEY]: id}}});

    it('a call to an action a subscribed resource lists in changesWith sends one updated for that URI only', async() => {
      see('k', null, U1, 'd1', ['notesService.save']);
      see('k', null, U2, 'd1', ['notesService.other']);
      const l = listener(5, {resourceSubscriptions: [U1, U2]});
      called('k', 'd1', 'notesService', 'save');
      assert.ok(await until(() => l.got.length === 1));
      await tick(40);
      assert.deepStrictEqual(l.got, [updated(5, U1)]);
    });

    it('calls within one settle make one updated per URI', async() => {
      see('k', null, U1, 'd1', ['notesService.save', 'notesService.remove']);
      const l = listener(5, {resourceSubscriptions: [U1]});
      called('k', 'd1', 'notesService', 'save');
      called('k', 'd1', 'notesService', 'remove');
      called('k', 'd1', 'notesService', 'save');
      assert.ok(await until(() => l.got.length === 1));
      await tick(40);
      assert.deepStrictEqual(l.got, [updated(5, U1)]);
    });

    it('another key\'s call, another device, an action not listed, or a URI that no longer resolves: nothing', async() => {
      see('k', null, U1, 'd1', ['notesService.save']);
      see('other', null, U1, 'd1', ['notesService.save']);
      const l = listener(5, {resourceSubscriptions: [U1, U2]});
      called('other', 'd1', 'notesService', 'save');
      called('k', 'd2', 'notesService', 'save');
      called('k', 'd1', 'notesService', 'read');
      called('k', 'd1', 'otherService', 'save');
      await tick(60);
      assert.deepStrictEqual(l.got, []);
      views['k|null'] = {};
      called('k', 'd1', 'notesService', 'save');
      await tick(60);
      assert.deepStrictEqual(l.got, [], 'unloaded: the URI resolves to nothing');
    });

    it('with no listener holding a URI, a call resolves nothing', async() => {
      listener(1, {toolsListChanged: true});
      called('k', 'd1', 'notesService', 'save');
      await tick(40);
      assert.deepStrictEqual(resolved, []);
    });

    it('each listener resolves its URIs in its own view (its key and session)', async() => {
      see('k', 'sA', U1, 'd1', ['notesService.save']);
      // sB's view does not list the module (a pack hidden from it)
      const a = listener(1, {resourceSubscriptions: [U1]}, 'k', 'sA');
      const b = listener(2, {resourceSubscriptions: [U1]}, 'k', 'sB');
      called('k', 'd1', 'notesService', 'save', 'sA');
      assert.ok(await until(() => a.got.length === 1));
      await tick(40);
      assert.deepStrictEqual(b.got, []);
      assert.ok(resolved.some((r) => r[1] === 'sA') && resolved.some((r) => r[1] === 'sB'), JSON.stringify(resolved));
    });

    it('a shared module\'s change reaches every session of the key that sees the URI; a per-session module\'s only the calling session', async() => {
      for (const s of ['sA', 'sB']) see('k', s, U1, 'd1', ['notesService.save']);
      const a = listener(1, {resourceSubscriptions: [U1]}, 'k', 'sA');
      const b = listener(2, {resourceSubscriptions: [U1]}, 'k', 'sB');
      called('k', 'd1', 'notesService', 'save', 'sA');
      assert.ok(await until(() => a.got.length === 1 && b.got.length === 1), 'shared: both');
      perSessionDevices.add('d1');
      called('k', 'd1', 'notesService', 'save', 'sA');
      assert.ok(await until(() => a.got.length === 2));
      await tick(40);
      assert.strictEqual(b.got.length, 1, 'per-session: sA\'s save says nothing to sB');
      // a call with no session (a site that does not know it) reaches no
      // per-session module's listener
      called('k', 'd1', 'notesService', 'save', null);
      await tick(60);
      assert.deepStrictEqual([a.got.length, b.got.length], [2, 1]);
    });

    it('another key\'s call never moves this key\'s settle: each key (and session) is batched and timed apart', async() => {
      const slow = createHub({lists: {}, settleMs: 60, perSession: () => false,
        resolveUris: async(appKey, session, uris) => new Map(uris.map((u) => [u, {deviceID: 'd1', changesWith: ['notesService.save']}]))});
      const at = {};
      slow.open({id: 1, appKey: 'ka', filter: {resourceSubscriptions: [U1]}, write: () => { at.a = Date.now(); }, finish: () => {}});
      slow.open({id: 2, appKey: 'kb', filter: {resourceSubscriptions: [U1]}, write: () => { at.b = Date.now(); }, finish: () => {}});
      const t0 = Date.now();
      slow.callSucceeded({appKey: 'ka', deviceID: 'd1', serviceID: 'notesService', actionName: 'save'});
      await tick(40);
      const tb = Date.now();
      slow.callSucceeded({appKey: 'kb', deviceID: 'd1', serviceID: 'notesService', actionName: 'save'});
      assert.ok(await until(() => at.a != null && at.b != null));
      assert.ok(at.a - t0 >= 55, `A's notice came ${at.a - t0} ms after its call`);
      assert.ok(at.b - tb >= 55, `B's notice came ${at.b - tb} ms after its call: B's settle was moved by A's call`);
    });

    it('a settle\'s calls are held once each; its round lists each view once; a round never overlaps the last', async() => {
      let running = 0;
      let most = 0;
      let resolves = 0;
      const h = createHub({lists: {}, settleMs: 5, perSession: () => false, resolveUris: async(appKey, session, uris) => {
        resolves++;
        running++;
        most = Math.max(most, running);
        await tick(80);
        running--;
        return new Map(uris.map((u) => [u, {deviceID: 'd1', changesWith: ['notesService.save']}]));
      }});
      const got = [[], []];
      for (const i of [0, 1]) h.open({id: i, appKey: 'k', filter: {resourceSubscriptions: [U1, U2]}, write: (m) => got[i].push(m.params.uri), finish: () => {}});
      for (let n = 0; n < 20; n++) h.callSucceeded({appKey: 'k', deviceID: 'd1', serviceID: 'notesService', actionName: 'save'});
      assert.ok(await until(() => got[0].length === 2 && got[1].length === 2));
      assert.strictEqual(resolves, 1, 'two listeners of one view, twenty identical calls: one resolve');
      // calls while that round runs wait for the next one
      for (let n = 0; n < 3; n++) {
        h.callSucceeded({appKey: 'k', deviceID: 'd1', serviceID: 'notesService', actionName: 'save'});
        await tick(20);
      }
      assert.ok(await until(() => got[0].length === 4));
      assert.strictEqual(most, 1, 'two rounds ran at once');
    });

    it('a closed subscription is sent nothing', async() => {
      see('k', null, U1, 'd1', ['notesService.save']);
      const l = listener(5, {resourceSubscriptions: [U1]});
      l.opened.close();
      called('k', 'd1', 'notesService', 'save');
      await tick(60);
      assert.deepStrictEqual(l.got, []);
    });
  });

  // the hub's own reads of a listener's lists (lib/route-manager.js, with
  // wholeList) resolve its identity and never spend its rate limit: a key at
  // its limit still has its lists compared, and a change is never skipped
  describe('the lists the hub reads', () => {
    const options = require('../../lib/cli-options');
    const gateway = require('../../lib/mcp/gateway');
    const KEY = 'hub-lists-key';
    const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
    let saved;
    before(() => { saved = {debug: options.debug, debugKey: options.debugKey}; options.debug = true; options.debugKey = KEY; });
    after(() => { options.debug = saved.debug; options.debugKey = saved.debugKey; });
    // an interface whose rate limit is spent, with no module loaded
    const spent = {rateLimit: (key, cb) => cb(null, {limited: true}), deviceManager: {getAllDeviceSpecs: () => ({}), deviceMap: {}}};
    const ask = (method, opts) => new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 1, method, params: {_meta: META}}, spent, KEY,
      (err, res) => resolve(res), opts));
    it('a client\'s resources/list at its limit is refused; the hub\'s whole-list read is answered', async() => {
      for (const method of ['resources/list', 'resources/templates/list']) {
        const asked = await ask(method, {});
        assert.ok(asked.error != null && /rate limit/.test(asked.error.message), JSON.stringify(asked));
        const hubs = await ask(method, {wholeList: true});
        assert.ok(hubs.result != null, JSON.stringify(hubs));
      }
    });
  });
});
