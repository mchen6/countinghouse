// ctx.usage() (the reviewer, 2026-11-13, the pack receipt): read-only, the
// current call's counts so far -- its server calls, the lines and bytes they
// returned and the tokens that estimates, inner hops' calls included --
// never a key, an id or a caller. The call's own output is measured when it
// returns, so it is not among them. A worker's query is its claim, checked
// on the main thread as a remote call's is: the call's token for that
// worker, and a usage call that worker was given.
const assert = require('assert');
const wt = require('worker_threads');
const {createUsage} = require('../../lib/usage');
const remoteUsage = require('../../lib/remote/usage');
const callTokens = require('../../lib/call-tokens');
const {answerUsageQuery} = require('../../lib/usage/query');
require('../../lib/logger').createLogger(false);

describe('usage 14: ctx.usage(), the current call\'s counts so far', () => {
  const W = 51;
  let u = null;
  const recordIn = (call, server, bytes, lines, extra) => u.recordIn(call, Object.assign({server, module: 'access', tool: 'get', bytes, lines, ms: 3, outcome: 'ok', credential: 'GH_TOKEN'}, extra));
  const tokenFor = (workerId) => callTokens.issue({billingKey: 'k-14', module: 'scenario', workerId: workerId, deviceID: 'd-14'});
  beforeEach(() => {
    u = createUsage({usageDir: null, pid: 1, startMs: 1});
    remoteUsage.setRecorder(u);
  });
  after(() => remoteUsage.setRecorder(null));

  describe('the recorder', () => {
    it('sums the call\'s server calls so far, by server, with the bytes/4 token estimate, and nothing else', () => {
      const call = u.beginCall({pack: 'p', module: 'scenario', tool: 't', caller: 'u_secret'});
      assert.deepStrictEqual(u.soFar(call), {calls: 0, linesIn: 0, bytesIn: 0, tokensInEst: 0, servers: {}, sentence: 'no server was called'});
      recordIn(call, 'github', 4000, 120);
      recordIn(call, 'github', 1001, 3);
      recordIn(call, 'linear', 10, 1);
      assert.deepStrictEqual(u.soFar(call), {calls: 3, linesIn: 124, bytesIn: 5011, tokensInEst: 1253, servers: {github: 2, linear: 1},
        sentence: 'read 124 lines (4.9 KB) in 2 calls to github and 1 to linear'});
    });

    it('names the servers a stand-in answered, as the receipt does', () => {
      const call = u.beginCall({tool: 't'});
      recordIn(call, 'github', 8, 1, {mapped: true});
      assert.deepStrictEqual(u.soFar(call).standIn, ['github']);
      assert.strictEqual(u.soFar(call).sentence, 'read 1 line (8 B) in 1 call to github (acceptance stand-in)');
    });

    it('is a copy: changing it changes nothing recorded', () => {
      const call = u.beginCall({tool: 't'});
      recordIn(call, 'github', 8, 1);
      const seen = u.soFar(call);
      seen.calls = 99;
      seen.servers.github = 99;
      assert.deepStrictEqual(u.soFar(call), {calls: 1, linesIn: 1, bytesIn: 8, tokensInEst: 2, servers: {github: 1}, sentence: 'read 1 line (8 B) in 1 call to github'});
    });

    it('its sentence is the first half of the receipt\'s, word for word', () => {
      const call = u.beginCall({tool: 't'});
      recordIn(call, 'github', 4000, 120);
      recordIn(call, 'linear', 10, 1);
      const half = u.soFar(call).sentence;
      u.recordOut(call, {tool: 't', bytes: 10, lines: 1, ms: 1, outcome: 'ok'});
      assert.ok(u.receiptSentenceOf(call).startsWith(`${half}; `), u.receiptSentenceOf(call));
    });

    it('is null for a call that has finished or was never begun', () => {
      const call = u.beginCall({tool: 't'});
      u.recordOut(call, {tool: 't', bytes: 1, lines: 1, ms: 1, outcome: 'ok'});
      assert.strictEqual(u.soFar(call), null);
      assert.strictEqual(u.soFar(call + 1), null);
      assert.strictEqual(u.soFar('1'), null);
    });
  });

  describe('a worker\'s query, answered on the main thread', () => {
    it('a call the worker was given, with its token: the counts, inner hops\' calls included', () => {
      const call = u.beginCall({tool: 't'});
      const release = u.grantCall(call, W);
      recordIn(call, 'github', 40, 2);
      recordIn(call, 'github', 60, 3, {module: 'a-part-two-hops-in'});
      assert.deepStrictEqual(answerUsageQuery({usageCall: call, token: tokenFor(W)}, W), {calls: 2, linesIn: 5, bytesIn: 100, tokensInEst: 25, servers: {github: 2}, sentence: 'read 5 lines (100 B) in 2 calls to github'});
      release();
    });

    it('a call it was not given is refused USAGE_CALL_FOREIGN', () => {
      const call = u.beginCall({tool: 't'});
      u.grantCall(call, W + 1);
      assert.throws(() => answerUsageQuery({usageCall: call, token: tokenFor(W)}, W), {code: 'USAGE_CALL_FOREIGN'});
    });

    it('a token that is not this worker\'s is refused CALL_TOKEN_INVALID, before the call is looked at', () => {
      const call = u.beginCall({tool: 't'});
      u.grantCall(call, W);
      assert.throws(() => answerUsageQuery({usageCall: call, token: tokenFor(W + 1)}, W), {code: 'CALL_TOKEN_INVALID'});
      assert.throws(() => answerUsageQuery({usageCall: call + 1, token: 'f'.repeat(32)}, W), {code: 'CALL_TOKEN_INVALID'});
    });

    it('no call, or a finished one: null, with a live token or none (a peer channel\'s call, a call that has answered)', () => {
      assert.strictEqual(answerUsageQuery({token: tokenFor(W)}, W), null);
      assert.strictEqual(answerUsageQuery({token: null}, W), null);
      assert.strictEqual(answerUsageQuery({}, W), null);
      const call = u.beginCall({tool: 't'});
      u.grantCall(call, W);
      u.recordOut(call, {tool: 't', bytes: 1, lines: 1, ms: 1, outcome: 'ok'});
      assert.strictEqual(answerUsageQuery({usageCall: call, token: tokenFor(W)}, W), null);
      assert.strictEqual(answerUsageQuery({usageCall: call, token: null}, W), null, 'its token dropped when it answered');
    });
  });

  describe('ctx.usage()', () => {
    const handlerCtx = require('../../lib/handler-ctx');
    const device = {moduleName: 'scenario', _compositionSettled: true};
    const argsOf = (usageCall) => ({ctx: {billingKey: 'k-14'}, usageCall: usageCall, token: 'a'.repeat(32), input: {}});

    it('on the main thread (single-thread mode): the call\'s counts, read from the recorder', async () => {
      const call = u.beginCall({tool: 't'});
      recordIn(call, 'github', 12, 1);
      const ctx = handlerCtx.buildCtx(device, argsOf(call));
      assert.deepStrictEqual(await ctx.usage(), {calls: 1, linesIn: 1, bytesIn: 12, tokensInEst: 3, servers: {github: 1}, sentence: 'read 1 line (12 B) in 1 call to github'});
      assert.strictEqual(await handlerCtx.buildCtx(device, argsOf(null)).usage(), null, 'a call with no usage id (not a tools/call)');
    });

    it('in a worker: asks the main thread with the call\'s id and token, and gives back its answer', async () => {
      const CHUtil = require('../../lib/countinghouse-util');
      const saved = CHUtil.dm;
      let sent = null;
      CHUtil.dm = {workerMessage: {sendUsageQueryToParent: (d, cb) => { sent = d; cb(null, {calls: 4, linesIn: 9, bytesIn: 90, tokensInEst: 23, servers: {github: 4}}); }}};
      Object.defineProperty(wt, 'isMainThread', {value: false, configurable: true, writable: true});
      let answer;
      try {
        answer = await handlerCtx.buildCtx(device, argsOf(7)).usage();
      } finally {
        Object.defineProperty(wt, 'isMainThread', {value: true, configurable: true, writable: true});
        CHUtil.dm = saved;
      }
      assert.deepStrictEqual(sent, {usageCall: 7, token: 'a'.repeat(32)});
      assert.strictEqual(answer.calls, 4);
    });

    it('in a worker, a refusal rejects the promise with its code', async () => {
      const CHUtil = require('../../lib/countinghouse-util');
      const saved = CHUtil.dm;
      const {CountinghouseError} = require('../../lib/countinghouse-error');
      CHUtil.dm = {workerMessage: {sendUsageQueryToParent: (d, cb) => cb(new CountinghouseError('USAGE_CALL_FOREIGN', 'x'))}};
      Object.defineProperty(wt, 'isMainThread', {value: false, configurable: true, writable: true});
      try {
        await assert.rejects(handlerCtx.buildCtx(device, argsOf(7)).usage(), {code: 'USAGE_CALL_FOREIGN'});
      } finally {
        Object.defineProperty(wt, 'isMainThread', {value: true, configurable: true, writable: true});
        CHUtil.dm = saved;
      }
    });
  });
});
