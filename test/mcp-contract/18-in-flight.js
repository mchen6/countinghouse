// MCP completeness M19, spec section 13: the in-flight registry
// (lib/mcp/in-flight.js). A cancellable request is kept while it runs, by
// scope and id: stdio's one connection, or a shared runtime's session. A
// cancel names a request of its own scope only, costs one map lookup, and
// an unknown id or a finished request is ignored. An entry goes when its
// request answers.
const assert = require('assert');
const inFlight = require('../../lib/mcp/in-flight');

describe('mcp-contract 18: the in-flight registry (M19)', () => {
  afterEach(() => inFlight.clear());

  it('a cancel runs the request\'s cancel once, and its entry goes', () => {
    let n = 0;
    inFlight.register('stdio', 7, () => { n += 1; });
    assert.strictEqual(inFlight.cancel('stdio', 7), true);
    assert.strictEqual(inFlight.cancel('stdio', 7), false, 'gone: a second notice is ignored');
    assert.strictEqual(n, 1);
    assert.strictEqual(inFlight.size(), 0);
  });

  it('a request of another scope is never named: one session cannot cancel another\'s', () => {
    let a = 0;
    inFlight.register('session-a', 1, () => { a += 1; });
    assert.strictEqual(inFlight.cancel('session-b', 1), false);
    assert.strictEqual(inFlight.cancel('stdio', 1), false);
    assert.strictEqual(a, 0);
    assert.strictEqual(inFlight.cancel('session-a', 1), true);
    assert.strictEqual(a, 1);
  });

  it('ids are told apart by type: 1 and "1" are two requests', () => {
    const hit = [];
    inFlight.register('s', 1, () => hit.push('number'));
    inFlight.register('s', '1', () => hit.push('string'));
    inFlight.cancel('s', '1');
    assert.deepStrictEqual(hit, ['string']);
  });

  it('an entry goes when its request answers (the unregister), so a later cancel is ignored', () => {
    let n = 0;
    const done = inFlight.register('stdio', 'x', () => { n += 1; });
    done();
    assert.strictEqual(inFlight.cancel('stdio', 'x'), false);
    assert.strictEqual(n, 0);
    assert.strictEqual(inFlight.size(), 0);
  });

  it('an unregister after a newer request took the same id leaves the newer one', () => {
    let older = 0;
    let newer = 0;
    const doneOld = inFlight.register('s', 5, () => { older += 1; });
    inFlight.register('s', 5, () => { newer += 1; });
    doneOld();
    assert.strictEqual(inFlight.cancel('s', 5), true);
    assert.deepStrictEqual([older, newer], [0, 1]);
  });

  it('what is not a request id, or not a scope, is ignored without a throw', () => {
    for (const id of [undefined, null, {}, [], true, NaN]) assert.strictEqual(inFlight.cancel('s', id), false, String(id));
    for (const scope of [undefined, null, '', 3]) assert.strictEqual(inFlight.cancel(scope, 1), false);
    assert.doesNotThrow(() => inFlight.register(null, 1, () => {})());
    assert.strictEqual(inFlight.size(), 0, 'nothing kept without a scope and an id');
  });

  it('a flood of unknown ids keeps nothing and costs a lookup each', () => {
    inFlight.register('s', 'real', () => {});
    for (let i = 0; i < 100000; i++) inFlight.cancel('s', `nope-${i}`);
    assert.strictEqual(inFlight.size(), 1);
  });

  it('a cancel that throws is logged, never thrown to the transport', () => {
    inFlight.register('s', 1, () => { throw new Error('boom'); });
    assert.doesNotThrow(() => inFlight.cancel('s', 1));
  });
});
