'use strict';
// The startup levers' (1), spawned: a runtime started with --loadModule
// starts its validator pool with the process, before the startup discovery
// loads its first module (whose spec checks are the pool's first use); one
// started with no module starts none. The order is read from the runtime's
// log on stderr. The local store: no Redis, no port. The pool's lib side is
// module-loading 38.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {mkdtemp, remove} = require('../helpers/test-tmp');

const ROOT = path.join(__dirname, '..', '..');
const MODULE = path.join(ROOT, 'test', 'fixtures', 'handler-map-module');
const KEY = 'stdio-35-key';
const EARLY = 'validator pool: started with the process';

function start(home, modules) {
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio-35', devices: ['*']}}));
  return startStdio(['--workerThread', '--authConfigPath', auth, '--store', 'local', '--storePath', path.join(home, 'store'),
    '--moduleDataPath', path.join(home, 'module_data'), '--modulePath', path.join(home, 'modules'), ...modules.flatMap((m) => ['--loadModule', m])],
  {env: {COUNTINGHOUSE_API_KEY: KEY}});
}

describe('stdio 35: the validator pool starts with the process when there are modules to load', function() {
  this.timeout(60000);
  let home = null;
  let io = null;
  beforeEach(() => { home = mkdtemp('ch-stdio-35-'); });
  afterEach(async() => {
    if (io != null) await io.stop();
    io = null;
    remove(home);
  });

  it('--loadModule: the pool is started before the first module is loaded', async () => {
    io = start(home, [MODULE]);
    await io.request(INITIALIZE);
    // tools/list waits for the startup discovery: the module is loaded by then
    const list = await io.request({jsonrpc: '2.0', method: 'tools/list'}, 30000);
    assert.ok(list.result != null, JSON.stringify(list));
    const early = io.err.indexOf(EARLY);
    const firstLoad = io.err.indexOf('load local module from path:');
    assert.ok(early !== -1, `the pool's start is said: ${io.err.slice(-3000)}`);
    assert.ok(firstLoad !== -1, 'the module was loaded');
    assert.ok(early < firstLoad, 'the pool started before the first module load');
    assert.strictEqual(io.err.split(EARLY).length - 1, 1, 'once');
  });

  it('no module: no pool is started with the process', async () => {
    io = start(home, []);
    await io.request(INITIALIZE);
    const list = await io.request({jsonrpc: '2.0', method: 'tools/list'}, 30000);
    assert.ok(list.result != null, JSON.stringify(list));
    assert.strictEqual(io.err.indexOf(EARLY), -1, io.err.slice(-3000));
  });
});
