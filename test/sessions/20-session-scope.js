'use strict';
// Shared runtime B5, Task 0 (docs/superpowers/plans/2026-11-16-shared-runtime-b5-session-views.md):
// the scope rule (lib/session-scope.js). On a shared runtime a session sees
// what is its own and nothing else; outside shared mode the owner key alone
// decides, as today. Server-free.
const assert = require('assert');
const EventEmitter = require('events');
const scope = require('../../lib/session-scope');
const sessions = require('../../lib/sessions');

describe('sessions 20: the scope rule (shared runtime B5, Task 0)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  afterEach(() => sessions.resetForTests());

  it('outside shared mode a scope sees what any owner has: the owner key decides, as today', () => {
    for (const owner of [A, B, null, undefined]) assert.strictEqual(scope.sees(scope.of(A), owner), true, String(owner));
    assert.strictEqual(scope.sees(scope.of(null), B), true);
    assert.deepStrictEqual(scope.of(A), {shared: false, session: A});
  });

  it('in shared mode a session sees its own only; no scope sees what has no session; the runtime\'s own sees all', () => {
    sessions.attach(new EventEmitter());
    assert.strictEqual(scope.sees(scope.of(A), A), true);
    assert.strictEqual(scope.sees(scope.of(A), B), false);
    assert.strictEqual(scope.sees(scope.of(A), null), false);
    assert.strictEqual(scope.sees(scope.of(A), undefined), false);
    assert.strictEqual(scope.sees(scope.of(null), null), false, 'a null scope sees no null owner');
    assert.strictEqual(scope.sees(scope.of(null), A), false);
    for (const owner of [A, B, null]) assert.strictEqual(scope.sees(scope.INTERNAL, owner), true);
    assert.deepStrictEqual(scope.of(B), {shared: true, session: B});
  });

  it('a scope is frozen, and a session that is no string is none', () => {
    sessions.attach(new EventEmitter());
    const s = scope.of(A);
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(scope.INTERNAL));
    assert.deepStrictEqual(scope.of(7), {shared: true, session: null});
    assert.strictEqual(scope.sees({shared: true, session: A}, A), true, 'a plain object of the same shape');
  });
});

describe('sessions 20: the gateway\'s scope of a request', () => {
  const sessions = require('../../lib/sessions');
  const gateway = require('../../lib/mcp/gateway');
  afterEach(() => sessions.resetForTests());
  it('scopeOf(opts) is the scope of the request\'s session', () => {
    assert.deepStrictEqual(gateway.scopeOf({}), {shared: false, session: null});
    assert.strictEqual(typeof(gateway.sessionIdOf), 'function');
  });
});
