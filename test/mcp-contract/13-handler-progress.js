// MCP completeness M21, spec section 6: a handler's own progress,
// ctx.job.progress(n) outside a task. In the worker (lib/handler-ctx.js
// callProgressPoster): at most one post per 250 ms per call, the latest value
// winning, out-of-range values dropped there, none after the call answers --
// so the main thread's cost is bounded whatever a module does (the
// reviewer's condition). On the main thread (lib/device-manager.js
// onCallProgress): only the posting worker's own root token counts; a hop's
// report is dropped; the call's notifier then reports n of 100.
const assert = require('assert');
const {callProgressPoster} = require('../../lib/handler-ctx');
const {onCallProgress} = require('../../lib/device-manager');
const callTokens = require('../../lib/call-tokens');

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

describe('mcp-contract 13: a handler\'s own progress (M21)', () => {
  describe('in the worker: callProgressPoster', () => {
    const make = (c) => {
      const posts = [];
      const p = callProgressPoster((n) => posts.push(n), {now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer});
      return {p, posts};
    };

    it('100,000 calls at once are 2 posts: the first at once, the latest 250 ms later', () => {
      const c = clock();
      const {p, posts} = make(c);
      for (let i = 0; i < 100000; i++) p.progress((i / 100000) * 100);
      assert.deepStrictEqual(posts, [0]);
      c.advance(250);
      assert.strictEqual(posts.length, 2);
      assert.ok(Math.abs(posts[1] - 99.999) < 0.01, String(posts[1]));
    });

    it('100,000 calls spread over 2 s are at most one post per 250 ms', () => {
      const c = clock();
      const {p, posts} = make(c);
      for (let i = 0; i < 100000; i++) {
        p.progress((i / 100000) * 100);
        if (i % 50 === 0) c.advance(1);
      }
      c.advance(250);
      assert.ok(posts.length <= Math.ceil(2000 / 250) + 2, `${posts.length} posts`);
      assert.ok(posts.length >= 8, `${posts.length} posts`);
    });

    it('drops what is not a number from 0 to 100', () => {
      const c = clock();
      const {p, posts} = make(c);
      for (const bad of [-1, 101, NaN, Infinity, '50', null, undefined, {}]) p.progress(bad);
      c.advance(1000);
      assert.deepStrictEqual(posts, []);
    });

    it('nothing after the call answers (end): the pending value and the timer go', () => {
      const c = clock();
      const {p, posts} = make(c);
      p.progress(10);
      p.progress(20);
      assert.strictEqual(c.pending(), 1);
      p.end();
      assert.strictEqual(c.pending(), 0);
      p.progress(30);
      c.advance(1000);
      assert.deepStrictEqual(posts, [10]);
    });
  });

  describe('on the main thread: onCallProgress', () => {
    const reports = [];
    const notifier = {report: (n, total) => reports.push([n, total]), tick: () => {}};
    let root;
    let hop;
    before(() => {
      root = callTokens.issue({billingKey: 'k', workerId: 'w-outer', progress: notifier});
      hop = callTokens.issue({billingKey: 'k', workerId: 'w-part', parent: root});
    });
    after(() => { callTokens.drop(root); });
    beforeEach(() => { reports.length = 0; });

    it('the posting worker\'s own root token: its notifier reports n of 100', () => {
      onCallProgress({data: {token: root, progress: 40}}, {workerId: 'w-outer'});
      assert.deepStrictEqual(reports, [[40, 100]]);
    });

    it('another worker\'s token is dropped: a module reports only for a call of its own', () => {
      onCallProgress({data: {token: root, progress: 40}}, {workerId: 'w-part'});
      assert.deepStrictEqual(reports, []);
    });

    it('a hop\'s report is dropped: a part\'s percentage says nothing about the whole call', () => {
      onCallProgress({data: {token: hop, progress: 40}}, {workerId: 'w-part'});
      assert.deepStrictEqual(reports, []);
    });

    it('a malformed message is dropped, never thrown', () => {
      for (const data of [null, {}, {token: root}, {token: root, progress: 101}, {token: root, progress: '40'}, {token: 7, progress: 40}]) {
        assert.doesNotThrow(() => onCallProgress({data}, {workerId: 'w-outer'}));
      }
      assert.doesNotThrow(() => onCallProgress(null, {workerId: 'w-outer'}));
      assert.deepStrictEqual(reports, []);
    });
  });
});
