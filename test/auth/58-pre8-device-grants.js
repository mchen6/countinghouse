'use strict';
// 8.0 changed every device ID (lib/call-address.js). A grant written before
// that names a specific device's pre-8.0 ID no longer matches: a start says
// so once per module, naming the module and both IDs, never a key
// (lib/pre-8-device-ids.js; removed after release 1). In-process, a fake
// provider: entries() and listDevices() as every provider has them.
const assert = require('assert');
const {deviceIDForName} = require('../../lib/call-address');

describe('auth 58: a grant naming a loaded module\'s pre-8.0 device ID is said once', () => {
  // a fresh copy each case: the module keeps what it said for the process
  const fresh = () => {
    delete require.cache[require.resolve('../../lib/pre-8-device-ids')];
    return require('../../lib/pre-8-device-ids');
  };
  const providerOf = (grants) => ({
    entries: (cb) => cb(null, Object.keys(grants).map((apiKey) => ({apiKey}))),
    listDevices: (apiKey, cb) => cb(null, {devices: grants[apiKey]})
  });

  it('names the module, its old ID and its new one; once per module, never the key', async () => {
    const lib = fresh();
    const oldEcho = lib.pre8DeviceIDForName('echo-device');
    assert.notStrictEqual(oldEcho, deviceIDForName('echo-device'));
    const said = [];
    const provider = providerOf({'secret-key-1': [oldEcho, deviceIDForName('repo-scan')], 'secret-key-2': [oldEcho]});
    await lib.warnPre8Grants(provider, ['echo-device', 'repo-scan'], (l) => said.push(l));
    assert.strictEqual(said.length, 1, JSON.stringify(said));
    assert.match(said[0], new RegExp(`^grant for echo-device names its pre-8.0 device ID ${oldEcho}; the new one is ${deviceIDForName('echo-device')}`));
    assert.ok(!/secret-key/.test(said[0]), 'never a key');
    // a later pass (a module loaded after) says nothing again for it
    await lib.warnPre8Grants(provider, ['echo-device'], (l) => said.push(l));
    assert.strictEqual(said.length, 1);
  });

  it('says nothing for a current ID, a \'*\' grant, a module not loaded, or a provider that fails', async () => {
    const lib = fresh();
    const said = [];
    const warn = (l) => said.push(l);
    await lib.warnPre8Grants(providerOf({k: ['*', deviceIDForName('echo-device'), lib.pre8DeviceIDForName('not-loaded')]}), ['echo-device'], warn);
    await lib.warnPre8Grants({entries: (cb) => cb(new Error('down')), listDevices: () => {}}, ['echo-device'], warn);
    await lib.warnPre8Grants({entries: () => { throw new Error('threw'); }, listDevices: () => {}}, ['echo-device'], warn);
    await lib.warnPre8Grants(null, ['echo-device'], warn);
    assert.deepStrictEqual(said, []);
  });
});

// The start's own pass (lib/device-manager.js onAllModulesDiscovered): an
// auth file granting echo-device's pre-8.0 ID, the echo module loaded.
[['worker mode', '--workerThread', 9675], ['single-thread mode', '--no-workerThread', 9676]].forEach(([mode, flag, port]) => {
  describe(`auth 58: on a running server, ${mode}`, function() {
    this.timeout(60000);
    const fs = require('fs');
    const path = require('path');
    const {ROOT, startServer, stopServer, waitFor} = require('../helpers/sandbox-server');
    const {testPort} = require('../helpers/test-env');
    const tmp = require('../helpers/test-tmp').forFile(['ch-auth-58-']);
    let server = null;
    after(() => { if (server != null) stopServer(server); });

    it('logs the line once for a module whose pre-8.0 ID a grant names', async () => {
      const {pre8DeviceIDForName} = require('../../lib/pre-8-device-ids');
      const dir = tmp.mkdtemp('ch-auth-58-');
      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[`k${process.pid}abcdefabcdef`]: {userName: 'u', devices: [pre8DeviceIDForName('echo-device')]}}));
      server = await startServer(testPort(port), [flag, '--authProvider', 'file', '--authConfigPath', auth,
        '--moduleDataPath', path.join(dir, 'data'), '--loadModule', path.join(ROOT, 'pre-installed-packages', 'echo-device-module')]);
      const line = `grant for echo-device names its pre-8.0 device ID ${pre8DeviceIDForName('echo-device')}; the new one is ${deviceIDForName('echo-device')}`;
      await waitFor(() => server.output.includes(line), 15000, 'the warning', () => server.output.slice(-2000));
      assert.strictEqual(server.output.split(line).length - 1, 1, 'once');
    });

    tmp.hooks();
  });
});
