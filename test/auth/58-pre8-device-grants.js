'use strict';
// 8.0 changed every device ID (lib/call-address.js). A grant written before
// that names a specific device's pre-8.0 ID no longer matches: a start says
// so once per module, naming the module and both IDs, never a key
// (lib/pre-8-device-ids.js; removed after release 1). In-process, a fake
// provider with grantedDeviceIDs, as the file and sqlite providers have it:
// one call, the granted device IDs only.
const assert = require('assert');
const {deviceIDForName} = require('../../lib/call-address');
const {testPort} = require('../helpers/test-env');

describe('auth 58: a grant naming a loaded module\'s pre-8.0 device ID is said once', () => {
  // the module keeps what it checked and said for the process: reset around
  // each case, and after the file (one process runs the folder)
  const lib = require('../../lib/pre-8-device-ids');
  beforeEach(() => lib.resetForTests());
  after(() => lib.resetForTests());
  const providerOf = (ids) => {
    const p = {calls: 0, grantedDeviceIDs: (cb) => { p.calls += 1; cb(null, ids.slice()); }};
    return p;
  };
  const loaded = (...names) => () => names;

  it('names the module, its old ID and its new one; once per module, one provider call per pass', async () => {
    const oldEcho = lib.pre8DeviceIDForName('echo-device');
    assert.notStrictEqual(oldEcho, deviceIDForName('echo-device'));
    const said = [];
    const provider = providerOf([oldEcho, deviceIDForName('repo-scan')]);
    await lib.warnPre8Grants(provider, loaded('echo-device', 'repo-scan'), (l) => said.push(l));
    assert.strictEqual(said.length, 1, JSON.stringify(said));
    assert.match(said[0], new RegExp(`^grant for echo-device names its pre-8.0 device ID ${oldEcho}; the new one is ${deviceIDForName('echo-device')}`));
    assert.strictEqual(provider.calls, 1);
    // a later pass for the same modules (a reload re-emits discovery) asks nothing
    await lib.warnPre8Grants(provider, loaded('echo-device', 'repo-scan'), (l) => said.push(l));
    assert.strictEqual(provider.calls, 1, 'a module checked is not checked again');
    assert.strictEqual(said.length, 1);
  });

  it('after the auth configuration is reloaded (regranted), the modules loaded now are checked again; one unloaded since is not', async () => {
    const said = [];
    let now = ['echo-device', 'repo-scan'];
    const provider = providerOf([]);
    await lib.warnPre8Grants(provider, () => now, (l) => said.push(l));
    assert.deepStrictEqual(said, []);
    // an old auth.json restored, repo-scan uninstalled meanwhile
    provider.grantedDeviceIDs = (cb) => cb(null, [lib.pre8DeviceIDForName('echo-device'), lib.pre8DeviceIDForName('repo-scan')]);
    now = ['echo-device'];
    await lib.regranted();
    assert.strictEqual(said.length, 1, JSON.stringify(said));
    assert.match(said[0], /^grant for echo-device names its pre-8.0 device ID/);
  });

  it('a first ask that fails marks nothing checked: the next pass asks again, and warns', async () => {
    const said = [];
    let fail = true;
    const provider = {grantedDeviceIDs: (cb) => (fail ? cb(new Error('down')) : cb(null, [lib.pre8DeviceIDForName('echo-device')]))};
    await lib.warnPre8Grants(provider, loaded('echo-device'), (l) => said.push(l));
    assert.deepStrictEqual(said, []);
    fail = false;
    await lib.warnPre8Grants(provider, loaded('echo-device'), (l) => said.push(l));
    assert.strictEqual(said.length, 1, JSON.stringify(said));
  });

  it('a warn that throws is never an unhandled rejection', async () => {
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    try {
      await lib.warnPre8Grants(providerOf([lib.pre8DeviceIDForName('echo-device')]), loaded('echo-device'), () => { throw new Error('the log threw'); });
      await new Promise((r) => setImmediate(r));
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
    assert.strictEqual(unhandled, null, String(unhandled));
  });

  it('says nothing for a current ID, a module not loaded, a provider that fails or has no grantedDeviceIDs', async () => {
    const said = [];
    const warn = (l) => said.push(l);
    await lib.warnPre8Grants(providerOf([deviceIDForName('echo-device'), lib.pre8DeviceIDForName('not-loaded')]), loaded('echo-device'), warn);
    lib.resetForTests();
    await lib.warnPre8Grants({grantedDeviceIDs: (cb) => cb(new Error('down'))}, loaded('echo-device'), warn);
    await lib.warnPre8Grants({grantedDeviceIDs: () => { throw new Error('threw'); }}, loaded('echo-device'), warn);
    await lib.warnPre8Grants({entries: (cb) => cb(null, [])}, loaded('echo-device'), warn);
    await lib.warnPre8Grants(null, loaded('echo-device'), warn);
    assert.deepStrictEqual(said, []);
  });

  it('the file and sqlite providers name every granted device ID, \'*\' aside, and no key', async () => {
    const fs = require('fs');
    const path = require('path');
    const dir = require('../helpers/test-tmp').mkdtemp('ch-auth-58u-');
    try {
      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({'key-one-0123456789': {userName: 'one', devices: ['a', 'b']}, 'key-two-0123456789': {userName: 'two', devices: ['*', 'b', 'c']}}), {mode: 0o600});
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

// (--debug with an auth file still reads its grants, as composition does)
[['worker mode', ['--workerThread'], testPort(9675)], ['single-thread mode', ['--no-workerThread'], testPort(9676)],
  ['--debug with an auth file', ['--workerThread', '--debug', '--debugKey', 'auth58-debug-key-0123456789'], testPort(9677)]].forEach(([mode, flags, port]) => {
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
      fs.writeFileSync(auth, JSON.stringify({[`k${process.pid}abcdefabcdef`]: {userName: 'u', devices: [pre8DeviceIDForName('echo-device')]}}), {mode: 0o600});
      server = await startServer(port, [...flags, '--authProvider', 'file', '--authConfigPath', auth,
        '--moduleDataPath', path.join(dir, 'data'), '--loadModule', path.join(ROOT, 'pre-installed-packages', 'echo-device-module')]);
      const line = `grant for echo-device names its pre-8.0 device ID ${pre8DeviceIDForName('echo-device')}; the new one is ${deviceIDForName('echo-device')}`;
      await waitFor(() => server.output.includes(line), 15000, 'the warning', () => server.output.slice(-2000));
      assert.strictEqual(server.output.split(line).length - 1, 1, 'once');
      assert.ok(!server.output.includes(`k${process.pid}abcdefabcdef`), 'never the key');
    });

    tmp.hooks();
  });
});
