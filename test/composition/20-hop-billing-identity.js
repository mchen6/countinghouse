// Who pays for a hop's work, and what a module may see of it (reviewer and
// the review of 5723adf, 2026-11-12). A part reached by a hop bills whoever
// the hop bills, never the composing module's internal identity: its remote
// calls, its further hops and its recordUsage. The billing key is kept in the
// ctx closure, like the usage call id, and never put on ctx.caller, which every
// handler sees (test/auth/30: no keys reach modules).
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

  it('the caller identity is unchanged: no billingKey on it', () => {
    assert.deepStrictEqual(handlerCtx.callerIdentityOf({appKey: 'k1', username: 'alice', isAdmin: true}), {apiKey: 'k1', userName: 'alice', isAdmin: true});
    assert.deepStrictEqual(handlerCtx.callerIdentityOf({appKey: 'k1', billingKey: 'alice-key'}), {apiKey: 'k1', userName: null, isAdmin: false});
  });

  it('a session\'s billing key travels in its wire identity, and only when it has one', () => {
    assert.deepStrictEqual(handlerCtx.wireIdentityOf({appKey: 'internal', username: 'u', isAdmin: false, billingKey: 'alice-key'}), {appKey: 'internal', username: 'u', isAdmin: false, billingKey: 'alice-key'});
    assert.deepStrictEqual(handlerCtx.wireIdentityOf({appKey: 'k'}), {appKey: 'k', username: null, isAdmin: false});
  });

  it('a hop\'s callee bills the hop\'s key for its remote calls and recordUsage; ctx.caller has no key of it', async () => {
    const ctx = handlerCtx.buildCtx(device, {input: {}, ctx: {appKey: 'internal', username: null, isAdmin: false, billingKey: 'alice-key'}});
    assert.ok(!Object.values(ctx.caller).includes('alice-key'), `ctx.caller is ${JSON.stringify(ctx.caller)}`);
    assert.ok(!('billingKey' in ctx.caller));
    await ctx.call('remote:probe/echo_text', {});
    ctx.recordUsage('t', 1, () => {});
    assert.deepStrictEqual(seen.remote, ['alice-key']);
    assert.deepStrictEqual(seen.usage, ['alice-key']);
  });

  it('a call that is not a hop bills its caller\'s own key, as before', async () => {
    const ctx = handlerCtx.buildCtx(device, {input: {}, ctx: {appKey: 'bob-key', username: 'bob', isAdmin: false}});
    await ctx.call('remote:probe/echo_text', {});
    ctx.recordUsage('t', 1, () => {});
    assert.deepStrictEqual(seen.remote, ['bob-key']);
    assert.deepStrictEqual(seen.usage, ['bob-key']);
  });
});
