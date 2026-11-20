'use strict';
// 8.0 changed every device ID (lib/call-address.js). A grant written before
// that names a specific device's pre-8.0 ID no longer matches: a start says
// so once per module, naming the module and both IDs, never a key
// (lib/pre-8-device-ids.js; removed after release 1). In-process, a fake
// provider: entries() and listDevices() as every provider has them.
const assert = require('assert');
const {deviceIDForName} = require('../../lib/call-address');
const {testPort} = require('../helpers/test-env');

describe('auth 58: a grant naming a loaded module\'s pre-8.0 device ID is said once', () => {
  // a fresh copy each case: the module keeps what it said for the process
  const fresh = () => {
    delete require.cache[require.resolve('../../lib/pre-8-device-ids')];
    return require('../../lib/pre-8-device-ids');
  };
  // grantedDeviceIDs as the file and sqlite providers have it: the IDs
  // alone, one call (counted), never a key
  const providerOf = (ids) => {
    const p = {calls: 0, grantedDeviceIDs: (cb) => { p.calls += 1; cb(null, ids.slice()); }};
    return p;
  };

  it('names the module, its old ID and its new one; once per module, one provider call per pass', async () => {
    const lib = fresh();
    const oldEcho = lib.pre8DeviceIDForName('echo-device');
    assert.notStrictEqual(oldEcho, deviceIDForName('echo-device'));
    const said = [];
    const provider = providerOf([oldEcho, deviceIDForName('repo-scan')]);
    await lib.warnPre8Grants(provider, ['echo-device', 'repo-scan'], (l) => said.push(l));
    assert.strictEqual(said.length, 1, JSON.stringify(said));
    assert.match(said[0], new RegExp(`^grant for echo-device names its pre-8.0 device ID ${oldEcho}; the new one is ${deviceIDForName('echo-device')}`));
    assert.strictEqual(provider.calls, 1);
    // a later pass for the same modules (a reload re-emits discovery) asks nothing
    await lib.warnPre8Grants(provider, ['echo-device', 'repo-scan'], (l) => said.push(l));
    assert.strictEqual(provider.calls, 1, 'a module checked is not checked again');
    assert.strictEqual(said.length, 1);
  });

  it('after the auth configuration is reloaded (regranted), every loaded module is checked again', async () => {
    const lib = fresh();
    const said = [];
    const provider = providerOf([]);
    await lib.warnPre8Grants(provider, ['echo-device'], (l) => said.push(l));
    assert.deepStrictEqual(said, []);
    provider.grantedDeviceIDs = (cb) => cb(null, [lib.pre8DeviceIDForName('echo-device')]);   // an old auth.json restored
    await lib.regranted();
    assert.strictEqual(said.length, 1, JSON.stringify(said));
    assert.match(said[0], /^grant for echo-device names its pre-8.0 device ID/);
  });

  it('says nothing for a current ID, a module not loaded, a provider that fails or has no grantedDeviceIDs', async () => {
    const lib = fresh();
    const said = [];
    const warn = (l) => said.push(l);
    await lib.warnPre8Grants(providerOf([deviceIDForName('echo-device'), lib.pre8DeviceIDForName('not-loaded')]), ['echo-device'], warn);
    const lib2 = fresh();
    await lib2.warnPre8Grants({grantedDeviceIDs: (cb) => cb(new Error('down'))}, ['echo-device'], warn);
    await fresh().warnPre8Grants({grantedDeviceIDs: () => { throw new Error('threw'); }}, ['echo-device'], warn);
    await fresh().warnPre8Grants({entries: (cb) => cb(null, [])}, ['echo-device'], warn);
    await fresh().warnPre8Grants(null, ['echo-device'], warn);
    assert.deepStrictEqual(said, []);
  });

  it('the file and sqlite providers name every granted device ID, \'*\' aside, and no key', async () => {
    const fs = require('fs');
    const path = require('path');
    const dir = require('../helpers/test-tmp').mkdtemp('ch-auth-58u-');
    try {
      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({'key-one-0123456789': {userName: 'one', devices: ['a', 'b']}, 'key-two-0123456789': {userName: 'two', devices: ['*', 'b', 'c']}}));
      const FileAuthProvider = require('../../lib/auth/file-provider');
      const ids = await new Promise((resolve, reject) => new FileAuthProvider({configPath: auth}).grantedDeviceIDs((e, v) => (e ? reject(e) : resolve(v))));
      assert.deepStrictEqual(ids.sort(), ['a', 'b', 'c']);
      let sqlite = null;
      try { sqlite = require('../../lib/auth/sqlite-provider'); } catch (e) { sqlite = null; }
      if (sqlite != null) {
        const p = new sqlite({dbPath: path.join(dir, 'auth.db')});
        await new Promise((resolve) => p._whenReady(resolve, () => p.db.serialize(() => {
          p.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['key-one', 'a']);
          p.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['key-two', '*']);
          p.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['key-two', 'a'], () => resolve());
        })));
        const fromDb = await new Promise((resolve, reject) => p.grantedDeviceIDs((e, v) => (e ? reject(e) : resolve(v))));
        assert.deepStrictEqual(fromDb, ['a']);
        if (p.db != null) p.db.close();
      }
    } finally {
      require('../helpers/test-tmp').remove(dir);
    }
  });
});

[['worker mode', '--workerThread', testPort(9675)], ['single-thread mode', '--no-workerThread', testPort(9676)]].forEach(([mode, flag, port]) => {
  describe(`auth 58: on a running server, ${mode}`, function() {
    this.timeout(60000);
    const fs = require('fs');
    const path = require('path');
    const {ROOT, startServer, stopServer, waitFor} = require('../helpers/sandbox-server');
    const tmp = require('../helpers/test-tmp').forFile(['ch-auth-58-']);
    let server = null;
    after(() => { if (server != null) stopServer(server); });

    it('logs the line once for a module whose pre-8.0 ID a grant names', async () => {
      const {pre8DeviceIDForName} = require('../../lib/pre-8-device-ids');
      const dir = tmp.mkdtemp('ch-auth-58-');
      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[`k${process.pid}abcdefabcdef`]: {userName: 'u', devices: [pre8DeviceIDForName('echo-device')]}}));
      server = await startServer(port, [flag, '--authProvider', 'file', '--authConfigPath', auth,
        '--moduleDataPath', path.join(dir, 'data'), '--loadModule', path.join(ROOT, 'pre-installed-packages', 'echo-device-module')]);
      const line = `grant for echo-device names its pre-8.0 device ID ${pre8DeviceIDForName('echo-device')}; the new one is ${deviceIDForName('echo-device')}`;
      await waitFor(() => server.output.includes(line), 15000, 'the warning', () => server.output.slice(-2000));
      assert.strictEqual(server.output.split(line).length - 1, 1, 'once');
      assert.ok(!server.output.includes(`k${process.pid}abcdefabcdef`), 'never the key');
    });

    tmp.hooks();
  });
});
