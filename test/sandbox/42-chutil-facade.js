// R2-1 Task 5: the CHUtil a module's worker exposes as a global is a facade
// over the runtime's: no dm or ci, its plain properties live, and its methods
// called with the facade as `this`, so a wrapper the lockdown puts on the
// facade (CHUtil.request's host check, loadFile) is the one every other
// method reaches (the review of 5b: invokeAction went around it). Server-free.
const assert = require('assert');
require('../../lib/cli-options').setOptions({workerThread: false});

describe('sandbox 42: the CHUtil a module sees', () => {
  const CHUtil = require('../../lib/countinghouse-util');
  // required where used, so each case fails on its own before it exists
  const facade = () => CHUtil.moduleFacade();

  it('has no dm or ci', () => {
    const f = facade();
    assert.ok(!('dm' in f) && !('ci' in f), Object.keys(f).join(', '));
  });

  it('a method calls the facade\'s request, the one the lockdown wraps', (done) => {
    const f = facade();
    const seen = [];
    f.request = (opts, cb) => { seen.push(opts.url); cb(null, {statusCode: 200}, {output: {}}); };
    f.invokeAction('k', 'http://10.0.0.5:6379', 's', 'a', {input: {}}, () => {
      assert.deepStrictEqual(seen, ['http://10.0.0.5:6379/invoke-action']);
      done();
    });
  });

  it('reaches the runtime\'s device manager for a client, on the main thread', () => {
    // single-thread mode, whatever an earlier test in this run left set
    require('../../lib/cli-options').setOptions({workerThread: false});
    const saved = CHUtil.dm;
    const emitted = [];
    CHUtil.dm = {emit: (ev, deviceID) => emitted.push([ev, deviceID])};
    try {
      facade().createServiceClient({appKey: 'k', deviceID: 'd', serviceID: 's'}, () => {});
      assert.deepStrictEqual(emitted, [['querydevice', 'd']]);
    } finally {
      CHUtil.dm = saved;
    }
  });

  it('its plain properties are the runtime\'s, live', () => {
    const f = facade();
    const saved = CHUtil.redis;
    try {
      CHUtil.redis = {marker: 1};
      assert.strictEqual(f.redis.marker, 1);
    } finally {
      CHUtil.redis = saved;
    }
  });
});
