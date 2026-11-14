// Who pays for a hop's work, and what a module may see of it (reviewer and
// the review of 5723adf, 2026-11-12). A part reached by a hop bills whoever
// the hop bills, never the composing module's internal identity: its remote
// calls and its further hops. The billing key is kept in the ctx closure,
// like the usage call id, and never put on ctx.caller, which every handler
// sees (test/auth/30: no keys reach modules); in a worker there is no key at
// all, the main thread bills by the call's token (R2-1 Task 5).
// Server-free: buildCtx on the main thread, with lib/remote's callRemote and
// CHUtil.recordUsage stood in for.
const assert = require('assert');
require('../../lib/cli-options').setOptions({workerThread: false});
const handlerCtx = require('../../lib/handler-ctx');

describe('composition 20: a hop\'s billing key reaches the callee\'s work, never its ctx.caller', () => {
  const remote = require('../../lib/remote');
  const CHUtil = require('../../lib/countinghouse-util');
  let saved = null;
  const seen = {remote: [], usage: []};
  before(() => {
    saved = {callRemote: remote.callRemote, recordUsage: CHUtil.recordUsage};
    remote.callRemote = async (moduleName, name, tool, args, meta) => { seen.remote.push(meta.billingKey); return {content: []}; };
    CHUtil.recordUsage = (key, tool, cost, cb) => { seen.usage.push(key); if (cb) cb(null); };
  });
  after(() => { remote.callRemote = saved.callRemote; CHUtil.recordUsage = saved.recordUsage; });
  beforeEach(() => { seen.remote.length = 0; seen.usage.length = 0; });

  const device = {deviceID: 'd', moduleName: 'part', spec: {device: {friendlyName: 'part'}}, _compositionSettled: true};

  // R2-1 Task 5: a call that stays on the main thread (single-thread mode)
  // carries its billing key on its args under a private Symbol, set where
  // the call is sent (handlerCtx.attachBilling): never on ctx.caller, never
  // in a structured clone or JSON, so never in a worker or a task's data.
  const argsFor = (session) => {
    const args = {input: {}, ctx: handlerCtx.wireIdentityOf(session)};
    handlerCtx.attachBilling(args, session);
    return args;
  };

  it('the caller is {id, isAdmin}: no key and no user name on it', () => {
    assert.deepStrictEqual(handlerCtx.callerIdentityOf({id: 'u_a', isAdmin: true, appKey: 'k1', billingKey: 'alice-key'}), {id: 'u_a', isAdmin: true});
  });

  it('the billing key rides beside the wire, and no clone or JSON carries it', () => {
    const args = argsFor({appKey: 'internal', username: 'u', isAdmin: false, billingKey: 'alice-key'});
    assert.strictEqual(handlerCtx.billingKeyOf(args), 'alice-key');
    assert.ok(!JSON.stringify(args).includes('alice-key') && !JSON.stringify(args).includes('internal'), JSON.stringify(args));
    assert.strictEqual(handlerCtx.billingKeyOf(structuredClone(args)), null);
  });

  it('a hop\'s callee bills the hop\'s key for its remote calls; ctx.caller has no key; recordUsage names the caller by id', async () => {
    const ctx = handlerCtx.buildCtx(device, argsFor({appKey: 'internal', username: null, isAdmin: false, billingKey: 'alice-key'}));
    assert.ok(!JSON.stringify(ctx.caller).includes('alice-key') && !JSON.stringify(ctx.caller).includes('internal'), `ctx.caller is ${JSON.stringify(ctx.caller)}`);
    await ctx.call('remote:probe/echo_text', {});
    ctx.recordUsage('t', 1, () => {});
    assert.deepStrictEqual(seen.remote, ['alice-key']);
    assert.deepStrictEqual(seen.usage, [ctx.caller.id]);
  });

  it('a call that is not a hop bills its caller\'s own key, as before', async () => {
    const ctx = handlerCtx.buildCtx(device, argsFor({appKey: 'bob-key', username: 'bob', isAdmin: false}));
    await ctx.call('remote:probe/echo_text', {});
    assert.deepStrictEqual(seen.remote, ['bob-key']);
  });
});
