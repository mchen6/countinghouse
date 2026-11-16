// MCP completeness M9, spec section 6: the per-call progress notifier
// (lib/mcp/progress.js). Made only for a request whose params._meta carries
// a progressToken: a string of at most 256 characters or a safe integer,
// anything else ignored (the reviewer's bound: the token is echoed back in
// every notification). progress strictly increases; at most one notification
// per 250 ms, the latest winning; at most 240 per call; nothing after the
// answer (done) or after the client has gone; no message field, ever.
const assert = require('assert');
const {tokenOf, createProgress, MIN_INTERVAL_MS, MAX_PER_CALL} = require('../../lib/mcp/progress');

// a clock and timers the test drives by hand
function clock() {
  let t = 1000;
  let timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = {fn, at: t + ms}; timers.push(h); return h; },
    clearTimer: (h) => { timers = timers.filter((x) => x !== h); },
    advance(ms) {
      t += ms;
      for (const h of timers.filter((x) => x.at <= t)) { timers = timers.filter((x) => x !== h); h.fn(); }
    },
    pending: () => timers.length
  };
}
const make = (c, token = 'tok') => {
  const sent = [];
  const p = createProgress({token, send: (m) => sent.push(m), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer});
  return {p, sent, values: () => sent.map((m) => m.params.progress)};
};

describe('mcp-contract 10: the progress notifier (M9)', () => {
  it('the bounds are the spec\'s', () => {
    assert.deepStrictEqual([MIN_INTERVAL_MS, MAX_PER_CALL], [250, 240]);
  });

  it('a token is a string of at most 256 characters or a safe integer, from params._meta only', () => {
    assert.strictEqual(tokenOf({_meta: {progressToken: 'abc'}}), 'abc');
    assert.strictEqual(tokenOf({_meta: {progressToken: 7}}), 7);
    assert.strictEqual(tokenOf({_meta: {progressToken: 'x'.repeat(256)}}), 'x'.repeat(256));
    assert.strictEqual(tokenOf({_meta: {progressToken: ''}}), '', 'the empty string is a string');
    for (const bad of ['x'.repeat(257), 1.5, 2 ** 53, -(2 ** 53), NaN, null, true, {}, []]) {
      assert.strictEqual(tokenOf({_meta: {progressToken: bad}}), null, JSON.stringify(bad));
    }
    assert.strictEqual(tokenOf({arguments: {_meta: {progressToken: 'a'}}}), null, 'never from arguments');
    assert.strictEqual(tokenOf({}), null);
    assert.strictEqual(tokenOf(null), null);
  });

  it('a tick is sent at once, as notifications/progress with the token, no total and no message', () => {
    const c = clock();
    const {p, sent} = make(c, 42);
    p.tick();
    assert.deepStrictEqual(sent, [{jsonrpc: '2.0', method: 'notifications/progress', params: {progressToken: 42, progress: 1}}]);
  });

  it('at most one per 250 ms: ticks inside the interval coalesce, the latest winning', () => {
    const c = clock();
    const {p, values} = make(c);
    p.tick();
    p.tick();
    p.tick();
    assert.deepStrictEqual(values(), [1]);
    c.advance(249);
    assert.deepStrictEqual(values(), [1]);
    c.advance(1);
    assert.deepStrictEqual(values(), [1, 3], 'the latest of the coalesced ticks');
    c.advance(250);
    assert.deepStrictEqual(values(), [1, 3], 'nothing pending, nothing sent');
  });

  it('progress strictly increases: a reported value at or below the last is dropped; once reported, ticks stop', () => {
    const c = clock();
    const {p, sent, values} = make(c);
    p.tick();
    c.advance(300);
    p.report(50, 100);
    c.advance(300);
    p.report(50, 100);
    p.report(40, 100);
    c.advance(300);
    p.tick();
    c.advance(300);
    p.report(60, 100);
    // offset by the one tick before the first report (the ruling on #306)
    assert.deepStrictEqual(values(), [1, 51, 61]);
    assert.strictEqual(sent[1].params.total, 101);
  });

  it('at most 240 per call', () => {
    const c = clock();
    const {p, values} = make(c);
    for (let i = 0; i < 300; i++) { p.tick(); c.advance(250); }
    assert.strictEqual(values().length, 240);
  });

  it('nothing after done(), or after the client has gone; the timer is cleared', () => {
    for (const end of ['done', 'gone']) {
      const c = clock();
      const {p, values} = make(c);
      p.tick();
      p.tick();
      assert.strictEqual(c.pending(), 1);
      p[end]();
      assert.strictEqual(c.pending(), 0, end);
      p.tick();
      c.advance(1000);
      assert.deepStrictEqual(values(), [1], end);
    }
  });

  it('every token of a chain carries the outer call\'s notifier, so a hop under a dropped one still ticks it', () => {
    const callTokens = require('../../lib/call-tokens');
    const p = {tick: () => {}};
    const root = callTokens.issue({billingKey: 'k', workerId: 'w1', progress: p});
    const mid = callTokens.issue({billingKey: 'k', workerId: 'w2', parent: root});
    const leaf = callTokens.issue({billingKey: 'k', workerId: 'w3', parent: mid});
    assert.strictEqual(callTokens.progressOf(leaf), p);
    callTokens.drop(mid);
    assert.strictEqual(callTokens.progressOf(root), p);
    const other = callTokens.issue({billingKey: 'k', workerId: 'w4'});
    assert.strictEqual(callTokens.progressOf(other), null, 'a call without a token\'s notifier has none');
    callTokens.drop(root);
    callTokens.drop(other);
  });

  it('a send that throws (the stream gone) ends the notifier, never the call', () => {
    const c = clock();
    const p = createProgress({token: 't', send: () => { throw new Error('gone'); }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer});
    assert.doesNotThrow(() => p.tick());
    assert.doesNotThrow(() => { c.advance(300); p.tick(); });
  });

  it('a report after hop ticks is offset by them, so it still increases and is not swallowed (the reviewer\'s ruling)', () => {
    const c = clock();
    const {p, sent} = make(c);
    for (let i = 0; i < 30; i++) { p.tick(); c.advance(300); }
    const ticks = sent.length;
    assert.strictEqual(sent[ticks - 1].params.progress, 30);
    p.report(25, 100);
    c.advance(300);
    p.report(60, 100);
    c.advance(300);
    p.tick();
    c.advance(300);
    assert.deepStrictEqual(sent.slice(ticks).map((m) => [m.params.progress, m.params.total]), [[55, 130], [90, 130]], 'ticks + n of ticks + 100; no tick after');
  });

  it('a report with no ticks before it is not offset: n of 100', () => {
    const c = clock();
    const {p, sent} = make(c);
    p.report(25, 100);
    assert.deepStrictEqual(sent.map((m) => [m.params.progress, m.params.total]), [[25, 100]]);
  });
});
