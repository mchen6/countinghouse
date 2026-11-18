'use strict';
// The startup levers' (1): a start with modules to load (--loadModule) starts
// the validator pool with the process (framework.js, right after the options
// are logged), so its validators boot beside the main thread's own boot and
// are ready, or nearly, when the first module's spec checks need them. A
// start with none starts no validator. Server-free, with real validators;
// the spawned order is test/stdio/35.
const assert = require('assert');
const options = require('../../lib/cli-options');
const LOG = require('../../lib/logger');
LOG.createLogger();
const validatorPool = require('../../lib/validator-pool');

describe('module-loading 38: the validator pool starts with the process when there are modules to load', function() {
  this.timeout(30000);
  const logged = [];
  let logI = null;
  let savedPath;
  let savedThread;
  before(() => {
    savedThread = options.workerThread;
    options.workerThread = true;
    savedPath = options.localModulePath;
    logI = LOG.I;
    LOG.I = (line) => { logged.push(String(line)); return line; };
  });
  after(() => {
    LOG.I = logI;
    options.workerThread = savedThread;
    if (savedPath === undefined) delete options.localModulePath; else options.localModulePath = savedPath;
    validatorPool.closeShared();
  });
  beforeEach(() => { validatorPool.closeShared(); logged.length = 0; options.workerThread = true; });

  it('no --loadModule: starts nothing (the pool waits for its first use, as before)', () => {
    delete options.localModulePath;
    assert.strictEqual(validatorPool.startEarly(), null);
    assert.strictEqual(validatorPool.started(), null, 'no pool');
    assert.deepStrictEqual(logged.filter((l) => /validator pool: started/.test(l)), []);
  });

  it('no module named (a bare --loadModule, an empty list) or --no-workerThread: starts nothing', () => {
    for (const dirs of [true, '', []]) {
      options.localModulePath = dirs;
      assert.strictEqual(validatorPool.startEarly(), null, JSON.stringify(dirs));
    }
    options.localModulePath = '/modules/a';
    options.workerThread = false;
    assert.strictEqual(validatorPool.startEarly(), null, 'no spec is checked in a validator under --no-workerThread');
    assert.strictEqual(validatorPool.started(), null, 'no pool');
  });

  it('--loadModule given once (a string, as minimist gives it): started', () => {
    options.localModulePath = '/modules/a';
    const p = validatorPool.startEarly();
    assert.ok(p != null && validatorPool.started() === p);
  });

  it('--loadModule: the shared pool is started, its validators and spare spawning, and said once', () => {
    options.localModulePath = ['/modules/a'];
    const p = validatorPool.startEarly();
    assert.ok(p != null && validatorPool.started() === p, 'the shared pool, the one pool() answers');
    assert.ok(validatorPool.pool() === p, 'first use finds it started');
    assert.ok(p.size >= 1 && p.slots.length === p.size, `${p.slots.length} slots of ${p.size}`);
    assert.ok(p.slots.every((s) => s.worker != null) && p.spare != null && p.spare.worker != null, 'validators spawning now');
    assert.strictEqual(logged.filter((l) => /validator pool: started with the process, for --loadModule/.test(l)).length, 1, logged.join('\n'));
    // a second call starts nothing more
    assert.strictEqual(validatorPool.startEarly(), null);
    assert.ok(validatorPool.started() === p);
  });

  it('a pool already started (first use came first) is left as it is', () => {
    options.localModulePath = ['/modules/a'];
    const first = validatorPool.pool();
    assert.strictEqual(validatorPool.startEarly(), null);
    assert.ok(validatorPool.started() === first);
  });
});
