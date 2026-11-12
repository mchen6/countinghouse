'use strict';

// LM1 B2, Task 2 (plan 2026-11-11-lm1-store-and-identity.md): --store,
// --storePath, --meter, and the start-up checks (spec section 1:
// "--redisUrl with --store local is a startup error (exit 2, "choose
// one")").

const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.resolve(__dirname, '../..');

function optionsFor(argv) {
  const script = `
    const options = require(${JSON.stringify(path.join(ROOT, 'lib', 'cli-options'))});
    options.setOptions(${JSON.stringify(argv)});
    const w = options.getOptionsForWorker();
    process.stdout.write(JSON.stringify({store: options.store, storePath: options.storePath, meter: options.meter,
      redisUrlExplicit: options.redisUrlExplicit, moduleDataPath: options.moduleDataPath,
      workerHasStorePath: Object.prototype.hasOwnProperty.call(w, 'storePath')}));
  `;
  const run = spawnSync(process.execPath, ['-e', script], {cwd: ROOT, encoding: 'utf8', timeout: 20000});
  assert.strictEqual(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function start(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1', '--port', '9695'].concat(args),
    {cwd: ROOT, encoding: 'utf8', timeout: 20000});
}

describe('store 03: --store, --storePath, --meter (LM1 B2)', function() {
  this.timeout(60000);

  it('defaults: the redis store, <moduleDataPath>/../store, no --meter', () => {
    const o = optionsFor({moduleDataPath: '/tmp/ch-store-03/module_data'});
    assert.strictEqual(o.store, 'redis');
    assert.strictEqual(o.storePath, path.resolve('/tmp/ch-store-03/module_data', '..', 'store'));
    assert.strictEqual(o.meter, false);
    assert.strictEqual(o.redisUrlExplicit, false);
  });

  it('takes --store local, --storePath, --meter and an explicit --redisUrl', () => {
    const o = optionsFor({store: 'local', storePath: 'rel/store', meter: true, redisUrl: 'redis://127.0.0.1:6380'});
    assert.strictEqual(o.store, 'local');
    assert.strictEqual(o.storePath, path.resolve('rel/store'));
    assert.strictEqual(o.meter, true);
    assert.strictEqual(o.redisUrlExplicit, true);
  });

  it('a worker is not given the store path', () => {
    assert.strictEqual(optionsFor({}).workerHasStorePath, false);
  });

  it('--store local with --redisUrl refuses to start: choose one', () => {
    const run = start(['--store', 'local', '--redisUrl', 'redis://127.0.0.1:6379']);
    assert.strictEqual(run.status, 2, run.stderr);
    assert.ok(/choose one/.test(run.stderr), run.stderr);
  });

  it('an unknown --store refuses to start', () => {
    const run = start(['--store', 'nonsense']);
    assert.strictEqual(run.status, 2, run.stderr);
    assert.ok(/--store must be redis or local/.test(run.stderr), run.stderr);
  });

  it('--store local refuses to start until the local store is complete (PR B5)', () => {
    const run = start(['--store', 'local']);
    assert.strictEqual(run.status, 2, run.stderr);
    assert.ok(/--store local is not complete in this build/.test(run.stderr), run.stderr);
  });
});
