'use strict';
// A shared runtime's legacy session (2025-11-25: it sent initialize, as
// Claude Code does when its server/discover probe timed out on a cold start)
// has no subscriptions/listen stream. Once it has asked for its list, each
// settled change to the tool set sends it one plain
// notifications/tools/list_changed
// (lib/session-transport/session-list-notices.js). A session that speaks
// 2026-07-28 is told nothing unasked.
const assert = require('assert');
const {EventEmitter} = require('events');
const {mock} = require('node:test');
const {createSessionListNotices} = require('../../lib/session-transport/session-list-notices');
const gateway = require('../../lib/mcp/gateway');

const LIST_CHANGED = {jsonrpc: '2.0', method: 'notifications/tools/list_changed'};
const PROMPTS_CHANGED = {jsonrpc: '2.0', method: 'notifications/prompts/list_changed'};
const RESOURCES_CHANGED = {jsonrpc: '2.0', method: 'notifications/resources/list_changed'};
const MODERN = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const pause = () => new Promise((r) => setImmediate(r));

function world(opts = {settleMs: 2}) {
  const registry = new EventEmitter();
  const sessions = new Map();
  registry.get = (id) => sessions.get(id) || null;
  const notices = createSessionListNotices(Object.assign({registry}, opts));
  const w = {registry, notices};
  let ids = 1;
  w.session = (id) => {
    const s = new EventEmitter();
    s.id = id;
    s.connected = true;
    s.sent = [];
    s.notify = (m) => s.sent.push(m);
    sessions.set(id, s);
    return s;
  };
  w.init = (s) => { notices.initialized(s); };
  w.list = (s, method = 'tools/list') => { notices.arrived(s, {jsonrpc: '2.0', id: ids++, method}); };
  w.legacy = (s) => { w.init(s); w.list(s); };
  w.detach = (s) => { s.connected = false; s.emit('detach'); };
  w.attach = (s) => { s.connected = true; s.emit('attach'); };
  w.gone = (s) => { sessions.delete(s.id); s.connected = false; registry.emit('gone', s.id, 'bye'); };
  // the settle has run (a bound on something observable)
  w.settled = async() => {
    const by = Date.now() + 1500;
    while (!notices.idleForTests() && Date.now() < by) await new Promise((r) => setTimeout(r, 1));
    assert.ok(notices.idleForTests(), 'settled');
    await pause();
  };
  w.change = async() => { notices.changed(); await w.settled(); };
  return w;
}

describe('session-transport 11: list_changed to a shared runtime\'s legacy session', () => {
  it('one plain notice for a change, to a session that has listed', async() => {
    const w = world();
    const s = w.session('s1');
    w.legacy(s);
    await w.change();
    assert.deepStrictEqual(s.sent, [LIST_CHANGED]);
    await w.change();
    assert.deepStrictEqual(s.sent, [LIST_CHANGED, LIST_CHANGED], 'each settled change is told');
  });

  // R-cold-prompts: a cold start's client lists its prompts before the packs
  // have loaded; each list it asked for is told, and only those
  it('a notice for each list it has asked for: its tools, its prompts, its resources (or their templates)', async() => {
    const w = world();
    const tools = w.session('tools');
    const prompts = w.session('prompts');
    const all = w.session('all');
    const templates = w.session('templates');
    for (const s of [tools, prompts, all, templates]) w.init(s);
    w.list(tools);
    w.list(prompts, 'prompts/list');
    w.list(all);
    w.list(all, 'prompts/list');
    w.list(all, 'resources/list');
    w.list(all, 'resources/list');
    w.list(templates, 'resources/templates/list');
    await w.change();
    assert.deepStrictEqual(tools.sent, [LIST_CHANGED]);
    assert.deepStrictEqual(prompts.sent, [PROMPTS_CHANGED]);
    assert.deepStrictEqual(all.sent, [LIST_CHANGED, PROMPTS_CHANGED, RESOURCES_CHANGED], 'each once, whatever it listed twice');
    assert.deepStrictEqual(templates.sent, [RESOURCES_CHANGED]);
  });

  it('a prompts/list with no id, or before its initialize, does not count', async() => {
    const w = world();
    const s = w.session('s1');
    w.notices.arrived(s, {jsonrpc: '2.0', id: 1, method: 'prompts/list'});
    w.init(s);
    w.notices.arrived(s, {jsonrpc: '2.0', method: 'prompts/list'});
    await w.change();
    assert.deepStrictEqual(s.sent, []);
  });

  it('a burst makes one notice, once it has settled', () => {
    mock.timers.enable({apis: ['setTimeout']});
    try {
      let clock = 0;
      const advance = (ms) => { clock += ms; mock.timers.tick(ms); };
      const w = world({settleMs: 20, maxWaitMs: 1000, now: () => clock});
      const s = w.session('s1');
      w.legacy(s);
      for (let i = 0; i < 3; i++) { w.notices.changed(); advance(10); }
      assert.deepStrictEqual(s.sent, [], 'still settling');
      advance(20);
      assert.deepStrictEqual(s.sent, [LIST_CHANGED]);
      advance(2000);
      assert.deepStrictEqual(s.sent, [LIST_CHANGED], 'and only one');
    } finally {
      mock.timers.reset();
    }
  });

  it('changes that never settle are told at the maximum wait', async() => {
    let clock = 0;
    const w = world({settleMs: 60000, maxWaitMs: 1000, now: () => clock});
    const s = w.session('s1');
    w.legacy(s);
    w.notices.changed();
    clock = 1000;
    w.notices.changed();
    await w.settled();
    assert.deepStrictEqual(s.sent, [LIST_CHANGED]);
  });

  it('none before it has listed; a session that never sent initialize is not followed', async() => {
    const w = world();
    const initialized = w.session('initialized');
    const never = w.session('never');
    const witness = w.session('witness');
    w.init(initialized);
    w.list(never);
    w.legacy(witness);
    await w.change();
    assert.deepStrictEqual(witness.sent, [LIST_CHANGED], 'the round ran');
    assert.deepStrictEqual(initialized.sent, []);
    assert.deepStrictEqual(never.sent, []);
    assert.strictEqual(w.notices.heldForTests(), 2);
  });

  it('a tools/list with no id does not count', async() => {
    const w = world();
    const s = w.session('s1');
    const witness = w.session('witness');
    w.init(s);
    w.notices.arrived(s, {jsonrpc: '2.0', method: 'tools/list'});
    w.legacy(witness);
    await w.change();
    assert.deepStrictEqual(witness.sent, [LIST_CHANGED], 'the round ran');
    assert.deepStrictEqual(s.sent, []);
  });

  for (const [name, message] of [
    ['server/discover', {jsonrpc: '2.0', id: 90, method: 'server/discover', params: {_meta: MODERN}}],
    ['a modern tools/list', {jsonrpc: '2.0', id: 91, method: 'tools/list', params: {_meta: MODERN}}],
    ['a modern tools/call', {jsonrpc: '2.0', id: 92, method: 'tools/call', params: {name: 'x', _meta: MODERN}}]
  ]) {
    it(`${name} ends it, and a replayed initialize follows it again from its next list`, async() => {
      const w = world();
      const s = w.session('s1');
      const witness = w.session('witness');
      w.legacy(s);
      w.legacy(witness);
      w.notices.arrived(s, message);
      await w.change();
      assert.strictEqual(witness.sent.length, 1, 'the round ran');
      assert.deepStrictEqual(s.sent, []);
      w.detach(s);
      w.attach(s);
      w.legacy(s);
      await w.change();
      assert.deepStrictEqual(s.sent, [LIST_CHANGED]);
    });
  }

  for (const [name, message] of [
    ['a bare server/discover', {jsonrpc: '2.0', id: 80, method: 'server/discover'}],
    ['a tools/call with only the version key', {jsonrpc: '2.0', id: 81, method: 'tools/call', params: {name: 'x', _meta: {'io.modelcontextprotocol/protocolVersion': '2026-07-28'}}}],
    ['an unsupported version', {jsonrpc: '2.0', id: 82, method: 'tools/list', params: {_meta: {'io.modelcontextprotocol/protocolVersion': '2099-01-01', 'io.modelcontextprotocol/clientCapabilities': {}}}}]
  ]) {
    it(`${name}, which the gateway refuses, leaves the session on 2025-11-25 and followed`, async() => {
      const w = world();
      const s = w.session('s1');
      w.legacy(s);
      w.notices.arrived(s, message);
      await w.change();
      assert.deepStrictEqual(s.sent, [LIST_CHANGED]);
    });
  }

  for (const [name, message] of [
    ['id null', {jsonrpc: '2.0', id: null, method: 'tools/list', params: {_meta: MODERN}}],
    ['no jsonrpc', {id: 83, method: 'tools/list', params: {_meta: MODERN}}],
    ['the wrong jsonrpc', {jsonrpc: '1.0', id: 84, method: 'tools/list', params: {_meta: MODERN}}],
    ['notifications/initialized with an id', {jsonrpc: '2.0', id: 85, method: 'notifications/initialized', params: {_meta: MODERN}}]
  ]) {
    it(`a modern-looking request with ${name}, which the gateway does not serve, leaves it followed`, async() => {
      const answer = await new Promise((resolve) => gateway.handle(message, null, null, (err, res) => resolve(res)));
      assert.ok(answer == null || answer.error != null, `the gateway does not serve it: ${JSON.stringify(answer)}`);
      const w = world();
      const s = w.session('s1');
      w.legacy(s);
      w.notices.arrived(s, message);
      await w.change();
      assert.deepStrictEqual(s.sent, [LIST_CHANGED]);
    });
  }

  for (const [name, message] of [
    ['id null', {jsonrpc: '2.0', id: null, method: 'tools/list'}],
    ['no jsonrpc', {id: 86, method: 'tools/list'}]
  ]) {
    it(`a tools/list with ${name}, which the gateway does not serve, does not count as listing`, async() => {
      const w = world();
      const s = w.session('s1');
      const witness = w.session('witness');
      w.init(s);
      w.notices.arrived(s, message);
      w.legacy(witness);
      await w.change();
      assert.strictEqual(witness.sent.length, 1, 'the round ran');
      assert.deepStrictEqual(s.sent, []);
    });
  }

  it('Claude Code\'s probe, a well-formed server/discover before its initialize, leaves it followed', async() => {
    const w = world();
    const s = w.session('s1');
    w.notices.arrived(s, {jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {_meta: MODERN}});
    w.legacy(s);
    await w.change();
    assert.deepStrictEqual(s.sent, [LIST_CHANGED]);
  });

  it('a tools/list that arrives before its initialize succeeded does not count', async() => {
    const w = world();
    const s = w.session('s1');
    const witness = w.session('witness');
    w.list(s);
    w.init(s);
    w.legacy(witness);
    await w.change();
    assert.strictEqual(witness.sent.length, 1, 'the round ran');
    assert.deepStrictEqual(s.sent, []);
  });

  it('a detach drops it: nothing while away, and after the reattach nothing until it lists', async() => {
    const w = world();
    const s = w.session('s1');
    const witness = w.session('witness');
    w.legacy(s);
    w.legacy(witness);
    w.detach(s);
    await w.change();
    assert.strictEqual(witness.sent.length, 1, 'the round ran');
    assert.deepStrictEqual(s.sent, []);
    w.attach(s);
    w.init(s);
    await w.change();
    assert.strictEqual(witness.sent.length, 2, 'the round ran');
    assert.deepStrictEqual(s.sent, []);
    w.list(s);
    await w.change();
    assert.deepStrictEqual(s.sent, [LIST_CHANGED]);
  });

  it('many reattaches add one detach listener', () => {
    const w = world();
    const s = w.session('s1');
    for (let i = 0; i < 5; i++) { w.legacy(s); w.detach(s); w.attach(s); }
    assert.strictEqual(s.listenerCount('detach'), 1);
  });

  it('an initialize answered on a detached or replaced session makes no state', () => {
    const w = world();
    const s = w.session('s1');
    s.connected = false;
    w.init(s);
    assert.strictEqual(w.notices.heldForTests(), 0);
    s.connected = true;
    w.gone(s);
    s.connected = true;
    w.init(s);
    assert.strictEqual(w.notices.heldForTests(), 0);
  });

  it('a session that ends frees its state', async() => {
    const w = world();
    const s = w.session('s1');
    w.legacy(s);
    assert.strictEqual(w.notices.heldForTests(), 1);
    w.gone(s);
    assert.strictEqual(w.notices.heldForTests(), 0);
    await w.change();
    assert.deepStrictEqual(s.sent, []);
  });

  it('a session whose write throws never stops another\'s notice', async() => {
    const w = world();
    const bad = w.session('bad');
    const ok = w.session('ok');
    let tried = 0;
    bad.notify = () => { tried += 1; throw new Error('its connection is gone'); };
    w.legacy(bad);
    w.legacy(ok);
    await w.change();
    assert.strictEqual(tried, 1);
    assert.deepStrictEqual(ok.sent, [LIST_CHANGED]);
  });

  it('after a drain nothing is said, a pending round included, and nothing new is followed', async() => {
    const w = world({settleMs: 20});
    const s = w.session('s1');
    w.legacy(s);
    w.notices.changed();
    w.notices.stop();
    assert.ok(w.notices.idleForTests(), 'its round is cancelled');
    await new Promise((r) => setTimeout(r, 40));
    assert.deepStrictEqual(s.sent, []);
    w.legacy(s);
    assert.strictEqual(w.notices.heldForTests(), 0);
    w.notices.changed();
    assert.ok(w.notices.idleForTests(), 'no round starts');
  });
});
