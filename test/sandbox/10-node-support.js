// The sandbox needs Node APIs that older releases lack (module.registerHooks,
// Worker getHeapStatistics, --permission). Without them the default mode
// must drop to off rather than leave module loads hanging.
const assert = require('assert');
const support = require('../../lib/sandbox-support');

function FakeWorker() {}

describe('sandbox 10: Node support', () => {
  it('reports nothing missing on this Node', () => {
    // The suite itself runs on a Node that has everything (test/sandbox needs it).
    assert.deepStrictEqual(support.missing(), []);
  });

  it('names each API the sandbox needs that is absent', () => {
    assert.deepStrictEqual(support.missing({Module: {}, Worker: FakeWorker}),
      ['module.registerHooks', 'Worker.getHeapStatistics']);
    FakeWorker.prototype.getHeapStatistics = function() {};
    assert.deepStrictEqual(support.missing({Module: {registerHooks() {}}, Worker: FakeWorker}), []);
    delete FakeWorker.prototype.getHeapStatistics;
  });

  it('defaults to audit under --workerThread when supported', () => {
    assert.deepStrictEqual(support.resolveMode(undefined, true, []), {mode: 'audit', explicit: false});
  });

  it('defaults to off when this Node lacks an API', () => {
    assert.deepStrictEqual(support.resolveMode(undefined, true, ['module.registerHooks']),
      {mode: 'off', explicit: false});
  });

  it('keeps an explicit mode as given, for framework.js to refuse', () => {
    assert.deepStrictEqual(support.resolveMode('enforce', true, ['module.registerHooks']),
      {mode: 'enforce', explicit: true});
  });

  it('defaults to off without --workerThread', () => {
    assert.deepStrictEqual(support.resolveMode(undefined, false, []), {mode: 'off', explicit: false});
  });

  it('knows whether this Node accepts --permission', () => {
    assert.strictEqual(support.hasPermissionModel(), true);
    assert.strictEqual(support.hasPermissionModel(new Set(['--experimental-permission'])), false);
  });
});
