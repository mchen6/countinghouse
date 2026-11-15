'use strict';
// B1 Task 2 (docs/superpowers/plans/2026-11-15-shared-runtime-b1-sessions.md):
// the session on each call, on the main thread only. A call's Session knows
// its session (sessionId); its call token carries it; a hop's token takes its
// parent's, and one issued with another session throws (a hop never changes
// session); the tokens of a session are indexed for its end (Task 4). The
// session never reaches a worker: no invoke message or token a worker holds
// names it. (Two real sessions over C1's transport calling a module are
// tested once C1 part 2 wires the gateway.)
const assert = require('assert');
const callTokens = require('../../lib/call-tokens');

describe('sessions 02: the session on each call and in its token (shared runtime B1, Task 2)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const issued = [];
  const issue = (o) => { const t = callTokens.issue(Object.assign({billingKey: 'k', workerId: 1}, o)); issued.push(t); return t; };
  afterEach(() => { for (const t of issued.splice(0)) callTokens.drop(t); });

  it('a call\'s Session starts with no session (HTTP, a job), and the gateway sets the request\'s', () => {
    const Session = require('../../lib/session');
    const s = new Session(null, null, 'u', 'k', 0, 'd', 0, () => {});
    assert.strictEqual(s.sessionId, null);
  });

  it('a token carries its call\'s session; a hop\'s takes its parent\'s; one with another session throws', () => {
    const top = issue({session: A});
    assert.strictEqual(callTokens.resolve(top, {workerId: 1}).session, A);
    const hop = issue({parent: top, workerId: 2});
    assert.strictEqual(callTokens.resolve(hop, {workerId: 2}).session, A);
    assert.throws(() => issue({parent: top, workerId: 3, session: B}), /a hop never changes session/);
    assert.strictEqual(callTokens.resolve(issue({workerId: 4}), {workerId: 4}).session, null, 'no session: null');
  });

  it('a session\'s live tokens are indexed (for its end), and a dropped one leaves the index', () => {
    const t1 = issue({session: A});
    const t2 = issue({parent: t1, workerId: 2});
    const t3 = issue({session: B, workerId: 3});
    assert.deepStrictEqual([...callTokens.ofSession(A)].sort(), [t1, t2].sort());
    assert.deepStrictEqual([...callTokens.ofSession(B)], [t3]);
    callTokens.drop(t1);   // drops its children too
    assert.deepStrictEqual([...callTokens.ofSession(A)], []);
    assert.deepStrictEqual([...callTokens.ofSession('c'.repeat(32))], []);
  });

  it('a session id is no billing or identity key: the entry\'s keys are as before, the session beside them', () => {
    const e = callTokens.resolve(issue({session: A, identityKey: 'id-key'}), {workerId: 1});
    assert.strictEqual(e.billingKey, 'k');
    assert.strictEqual(e.identityKey, 'id-key');
    assert.strictEqual(e.session, A);
  });
});
