'use strict';
// Shared runtime B3, Task 5: list_changed per session. A change to one
// session's view (its pack override, by whatever road) lists again only
// that session's listeners, and tells only the one whose list moved; a
// change with no session (a load, an unload, a pack made global) lists
// everyone, as the device manager's toolschanged does. Server-free, on
// lib/mcp/subscriptions.js createHub, with each session's tools a stand-in.
// (The plan names this file 17; 17 is Task 4's server-free hops.)
const assert = require('assert');
const {createHub, SUBSCRIPTION_ID_KEY} = require('../../lib/mcp/subscriptions');

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 3000) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await tick(10);
  return test();
};

describe('sessions 18: list_changed per session (shared runtime B3, Task 5)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  let tools;        // session -> its tools now
  let asked;        // the sessions listTools was asked for, in order
  let hub;
  beforeEach(() => {
    tools = {[A]: [{name: 'docs_search'}], [B]: [{name: 'docs_search'}]};
    asked = [];
    hub = createHub({listTools: async(appKey, session) => { asked.push(session); return tools[session]; }, settleMs: 5});
  });
  const listener = (id, session) => {
    const got = [];
    const opened = hub.open({id, appKey: 'k', session, filter: {toolsListChanged: true}, write: (m) => got.push(m), finish: () => {}});
    assert.strictEqual(opened.ok, true);
    return got;
  };
  const told = (id) => ({jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {_meta: {[SUBSCRIPTION_ID_KEY]: id}}});

  it('A\'s override for a loaded pack goes on: A\'s listener is told once, with its own id; B\'s is not', async() => {
    const a = listener(1, A);
    const b = listener(2, B);
    await tick();
    tools[A] = [{name: 'docs_search'}, {name: 'ci_failure_triage'}];
    hub.changed({session: A});
    assert.ok(await until(() => a.length === 1));
    await tick(40);
    assert.deepStrictEqual([a, b], [[told(1)], []]);
  });

  it('B turns a global pack off: only B\'s listener is told', async() => {
    const a = listener(3, A);
    const b = listener(4, B);
    await tick();
    tools[B] = [];
    hub.changed({session: B});
    assert.ok(await until(() => b.length === 1));
    await tick(40);
    assert.deepStrictEqual([a, b], [[], [told(4)]]);
  });

  it('a pack loaded for A, by the device manager\'s event (no session): B is listed again and not told, its list unchanged', async() => {
    const a = listener(5, A);
    const b = listener(6, B);
    await tick();
    asked.length = 0;
    tools[A] = [{name: 'docs_search'}, {name: 'ci_failure_triage'}];
    hub.changed();
    assert.ok(await until(() => a.length === 1));
    await tick(40);
    assert.deepStrictEqual([a, b], [[told(5)], []]);
    assert.deepStrictEqual(asked.slice().sort(), [A, B].sort(), 'both listed again');
  });

  it('a session-only change lists once, for that session: listTools is asked for A and not for B', async() => {
    listener(7, A);
    listener(8, B);
    await tick();
    asked.length = 0;
    hub.changed({session: A});
    hub.changed({session: A});
    await tick(60);
    assert.deepStrictEqual(asked, [A]);
  });

  it('a session change and a change with no session in one settle window make one round that lists everyone', async() => {
    listener(9, A);
    listener(10, B);
    await tick();
    asked.length = 0;
    hub.changed({session: A});
    hub.changed();
    await tick(60);
    assert.deepStrictEqual(asked.slice().sort(), [A, B].sort());
  });

  it('a global load tells both', async() => {
    const a = listener(11, A);
    const b = listener(12, B);
    await tick();
    tools[A] = [{name: 'docs_search'}, {name: 'new_tool'}];
    tools[B] = [{name: 'docs_search'}, {name: 'new_tool'}];
    hub.changed();
    assert.ok(await until(() => a.length === 1 && b.length === 1));
  });
});
