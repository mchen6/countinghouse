// Step 3c (reviewer, 2026-11-11): a worker cannot state another worker's
// usageCall. A call is owned by the workers it is sent to; a hop the main
// thread forwards from an owner grants the callee's worker for the hop's
// length; a usageCall its worker does not own is USAGE_CALL_FOREIGN; a call
// that has finished is no one's, and a hop stating it goes on without it, so
// nothing is recorded (the review of 3c).
const assert = require('assert');
const {createUsage} = require('../../lib/usage');
const {claimHop, checkHop} = require('../../lib/usage/hop');

describe('usage: a call is owned by the workers it was sent to', () => {
  const usage = () => createUsage({usageDir: null, pid: 1, startMs: 1, now: () => Date.parse('2026-11-11T12:00:00Z')});
  const begin = (u) => u.beginCall({pack: 'p', module: 'p', tool: 't', caller: 'u_a'});

  it('a grant lasts until it is released or the call ends, and grants to one worker count', () => {
    const u = usage();
    const call = begin(u);
    assert.strictEqual(u.ownsCall(call, 7), false);
    const r1 = u.grantCall(call, 7);
    const r2 = u.grantCall(call, 7);
    assert.strictEqual(u.ownsCall(call, 8), false);
    r1(); r1();
    assert.strictEqual(u.ownsCall(call, 7), true, 'a second grant still holds, and a release counts once');
    r2();
    assert.strictEqual(u.ownsCall(call, 7), false);
    u.grantCall(call, 7);
    u.recordOut(call, {tool: 't', bytes: 1, lines: 1, ms: 1, outcome: 'ok'});
    assert.strictEqual(u.ownsCall(call, 7), false, 'a finished call is no one\'s');
    u.grantCall(call, 9)();
    assert.strictEqual(u.ownsCall(call, 9), false, 'and cannot be granted');
  });

  it('a finished call is told from one never begun', () => {
    const u = usage();
    const call = begin(u);
    assert.deepStrictEqual([u.isFinished(call), u.isFinished(call + 1), u.isFinished(0), u.isFinished('1')], [false, false, false, false]);
    u.recordOut(call, {tool: 't', bytes: 1, lines: 1, ms: 1, outcome: 'ok'});
    assert.strictEqual(u.isFinished(call), true);
  });

  it('claimHop: the owner\'s id is claimed; a foreign one refused; a finished one removed from the args', () => {
    const u = usage();
    const call = begin(u);
    u.grantCall(call, 7);
    assert.deepStrictEqual(claimHop(u, {input: {}, usageCall: call}, 7), {call});
    for (const forged of [call, 999, '1', -1, 1.5, {}]) {
      const c = claimHop(u, {input: {}, usageCall: forged}, 8);
      assert.strictEqual(c.error && c.error.code, 'USAGE_CALL_FOREIGN', JSON.stringify(forged));
    }
    const done = begin(u);
    u.recordOut(done, {tool: 't', bytes: 1, lines: 1, ms: 1, outcome: 'ok'});
    const args = {input: {}, usageCall: done};
    assert.deepStrictEqual(claimHop(u, args, 8), {});
    assert.deepStrictEqual(args, {input: {}}, 'it goes on without the id');
    assert.deepStrictEqual(claimHop(u, {input: {}}, 8), {});
    assert.deepStrictEqual(claimHop(u, null, 8), {});
  });

  it('checkHop (the remote message\'s form): null to go on, or the refusal', () => {
    const u = usage();
    const call = begin(u);
    u.grantCall(call, 7);
    assert.strictEqual(checkHop(u, {usageCall: call}, 7, null), null);
    assert.strictEqual(checkHop(u, {usageCall: call}, 8, null).code, 'USAGE_CALL_FOREIGN');
    assert.strictEqual(checkHop(u, {}, 8, null), null);
  });
});
