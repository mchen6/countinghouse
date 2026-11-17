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

    it('a closed subscription is sent nothing', async() => {
      see('k', null, U1, 'd1', ['notesService.save']);
      const l = listener(5, {resourceSubscriptions: [U1]});
      l.opened.close();
      called('k', 'd1', 'notesService', 'save');
      await tick(60);
      assert.deepStrictEqual(l.got, []);
    });
  });
});
