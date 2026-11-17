// Shared runtime R1, Task 1 (design #236 section 4a): a module's state
// declaration, "countinghouse": {"state": "per-session"} in its package.json
// (lib/module-state.js). Absent or "shared" is shared; anything else refuses
// the load, naming the value. A per-session module loads on the shared runtime
// and under --stdio (where it runs as a shared one, on today's paths); on the
// HTTP hosting profile its load is refused MODULE_NEEDS_SESSIONS. A reload or
// an operator's restart that changes the state is refused
// MODULE_STATE_CHANGED before anything is unloaded.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const moduleState = require('../../lib/module-state');
const {testPort} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'per-session-module');
const NAME = 'per-session-module';
const pkgWith = (state) => (state === undefined ? {name: NAME, version: '1.0.0'} : {name: NAME, version: '1.0.0', countinghouse: {state}});

describe('module-loading 36: a module\'s state declaration (R1)', function() {
  this.timeout(120000);

  describe('lib/module-state.js', () => {
    it('absent or "shared" is shared, "per-session" is per-session, anything else refuses naming the value', () => {
      assert.strictEqual(moduleState.stateOf(pkgWith(undefined), NAME), 'shared');
      assert.strictEqual(moduleState.stateOf(pkgWith('shared'), NAME), 'shared');
      assert.strictEqual(moduleState.stateOf(null, NAME), 'shared', 'an unreadable file declares nothing');
      assert.strictEqual(moduleState.stateOf(pkgWith('per-session'), NAME), 'per-session');
      for (const bad of ['wobbly', null, 1, ['per-session'], {}, 'Per-Session']) {
        assert.throws(() => moduleState.stateOf(pkgWith(bad), NAME), (e) => e.code === 'MODULE_STATE_INVALID' && e.message.includes(NAME) && e.message.includes(JSON.stringify(bad)),
          JSON.stringify(bad));
      }
      const long = 'x'.repeat(500);
      assert.throws(() => moduleState.stateOf(pkgWith(long), NAME), (e) => e.message.length < 400, 'the value is cut');
    });

    it('the profile: the shared runtime, --stdio, or the HTTP hosting profile', () => {
      assert.strictEqual(moduleState.profileOf({sessionSocket: '/run/s'}), 'shared');
      assert.strictEqual(moduleState.profileOf({stdio: true}), 'stdio');
      assert.strictEqual(moduleState.profileOf({}), 'http');
    });

    it('a per-session module is refused only on the HTTP profile; a change of state is refused naming both', () => {
      assert.strictEqual(moduleState.stateProblem(pkgWith('per-session'), NAME, {sessionSocket: '/run/s'}), null);
      assert.strictEqual(moduleState.stateProblem(pkgWith('per-session'), NAME, {stdio: true}), null);
      assert.strictEqual(moduleState.stateProblem(pkgWith('per-session'), NAME, {}).code, 'MODULE_NEEDS_SESSIONS');
      assert.strictEqual(moduleState.stateProblem(pkgWith('shared'), NAME, {}), null);
      const changed = moduleState.stateChanged(pkgWith(undefined), pkgWith('per-session'), NAME);
      assert.strictEqual(changed.code, 'MODULE_STATE_CHANGED');
      assert.match(changed.message, /from shared to per-session; .*unload it first/);
      assert.strictEqual(moduleState.stateChanged(pkgWith('shared'), pkgWith(undefined), NAME), null, 'absent is shared');
      assert.strictEqual(moduleState.isPerSession(pkgWith('per-session'), NAME, {stdio: true}), false, '--stdio: no partition');
      assert.strictEqual(moduleState.isPerSession(pkgWith('per-session'), NAME, {sessionSocket: '/run/s'}), true);
    });
  });

  // The manager's checks, in-process: the load, the reload and the operator
  // restart reach loadModuleByWorker (a stub) only when the declaration is
  // let through, and a refused one unloads nothing.
  describe('the manager\'s checks, before anything is unloaded or spawned', () => {
    const options = require('../../lib/cli-options');
    const ModuleManager = require('../../lib/module-manager');
    const {ManifestPins} = require('../../lib/manifest-pins');
    let tmp = null;
    let saved = null;
    let calls = null;
    let mm = null;
    const moduleWith = (state) => {
      const dir = path.join(tmp, `m-${Math.random().toString(16).slice(2)}`, NAME);
      fs.cpSync(FIXTURE, dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgWith(state)));
      return dir;
    };
    const profile = (p) => {
      options.sessionSocket = p === 'shared' ? path.join(tmp, 's.sock') : undefined;
      options.stdio = p === 'stdio';
    };
    const answer = (fn) => new Promise((resolve) => fn((err, data) => resolve({err, data})));
    before(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-36-'));
      saved = {workerThread: options.workerThread, sessionSocket: options.sessionSocket, stdio: options.stdio};
      options.workerThread = true;
    });
    after(() => {
      Object.assign(options, saved);
      fs.rmSync(tmp, {recursive: true, force: true});
    });
    beforeEach(() => {
      calls = [];
      mm = Object.create(ModuleManager.prototype);
      mm.modules = {};
      mm.supervisor = null;
      mm.manifestPins = new ManifestPins({recordDir: () => path.join(tmp, '.pins'), log: () => {}});
      mm.loadModuleByWorker = (p, n, v, cb) => { calls.push('load'); cb(null, {}); };
      mm.unloadModuleExternal = (n, cb) => { calls.push('unload'); cb(); };
    });
    // a module loaded now, pinned with `state`
    const loaded = (state) => {
      mm.modules[NAME] = {modulePath: moduleWith(state), packageInfo: pkgWith(state)};
      mm.manifestPins.pinned.set(NAME, pkgWith(state));
    };

    it('the HTTP profile refuses a per-session module\'s load: MODULE_NEEDS_SESSIONS, nothing spawned', async () => {
      profile('http');
      const {err} = await answer((cb) => mm.loadModuleFromPath(moduleWith('per-session'), NAME, '1.0.0', cb));
      assert.strictEqual(err && err.code, 'MODULE_NEEDS_SESSIONS');
      assert.ok(err.message.includes(NAME));
      assert.deepStrictEqual(calls, []);
      const shared = await answer((cb) => mm.loadModuleFromPath(moduleWith('shared'), NAME, '1.0.0', cb));
      assert.strictEqual(shared.err, null, 'a shared module loads as ever');
    });

    it('an invalid value is refused on every profile, naming it', async () => {
      for (const p of ['shared', 'stdio', 'http']) {
        profile(p);
        const {err} = await answer((cb) => mm.loadModuleFromPath(moduleWith('wobbly'), NAME, '1.0.0', cb));
        assert.strictEqual(err && err.code, 'MODULE_STATE_INVALID', p);
        assert.ok(err.message.includes('"wobbly"'), err.message);
      }
      assert.deepStrictEqual(calls, []);
    });

    it('the shared runtime and --stdio load a per-session module', async () => {
      for (const p of ['shared', 'stdio']) {
        profile(p);
        const {err} = await answer((cb) => mm.loadModuleFromPath(moduleWith('per-session'), NAME, '1.0.0', cb));
        assert.strictEqual(err, null, p);
      }
      assert.deepStrictEqual(calls, ['load', 'load']);
    });

    it('a reload or an operator restart that changes the state is refused MODULE_STATE_CHANGED, the loaded module untouched', async () => {
      profile('shared');
      loaded('shared');
      const reload = await answer((cb) => mm.reloadModule(moduleWith('per-session'), cb));
      assert.strictEqual(reload.err && reload.err.code, 'MODULE_STATE_CHANGED');
      assert.match(reload.err.message, /from shared to per-session/);
      const restart = await answer((cb) => mm.restartModule(moduleWith('per-session'), NAME, '1.0.0', cb));
      assert.strictEqual(restart.err && restart.err.code, 'MODULE_STATE_CHANGED');
      const load = await answer((cb) => mm.loadModuleFromPath(moduleWith('per-session'), NAME, '1.0.0', cb));
      assert.strictEqual(load.err && load.err.code, 'MODULE_STATE_CHANGED', 'a load of a loaded module is its reload');
      assert.deepStrictEqual(calls, [], 'nothing unloaded, nothing spawned');
      // the same state reloads as ever
      const same = await answer((cb) => mm.reloadModule(moduleWith(undefined), cb));
      assert.strictEqual(same.err, null);
      assert.deepStrictEqual(calls, ['load']);
    });

    it('a module not loaded now takes whatever it declares: no change to refuse', async () => {
      profile('shared');
      mm.manifestPins.pinned.set(NAME, pkgWith('shared'));   // pinned once, unloaded since
      const {err} = await answer((cb) => mm.loadModuleFromPath(moduleWith('per-session'), NAME, '1.0.0', cb));
      assert.strictEqual(err, null);
    });
  });

  describe('spawned', () => {
    const {startServer, stopServer} = require('../helpers/sandbox-server');
    const {startStdio, waitForTool, INITIALIZE} = require('../helpers/stdio-client');
    const PORT = testPort(9729);
    let home = null;
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-36s-')); });
    afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

    it('the HTTP profile: a per-session module named at start is not loaded, and the log says MODULE_NEEDS_SESSIONS', async () => {
      const server = await startServer(PORT, ['--workerThread', '--moduleDataPath', path.join(home, 'module_data'), '--loadModule', FIXTURE]);
      try {
        for (let w = 0; !/MODULE_NEEDS_SESSIONS|keeps state per session/.test(server.output) && w < 20000; w += 100) await new Promise((r) => setTimeout(r, 100));
        assert.match(server.output, /per-session-module keeps state per session, which needs the shared runtime's sessions/, server.output.slice(-2000));
        assert.ok(!fs.existsSync(path.join(home, 'module_data', NAME, 'data', 'count')), 'nothing of it ran');
      } finally {
        stopServer(server);
      }
    });

    it('--stdio: a per-session module loads and runs as a shared one, on today\'s paths', async () => {
      const KEY = 'ml-36-key';
      const auth = path.join(home, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'ml-36', devices: ['*']}}));
      const io = startStdio(['--workerThread', '--authConfigPath', auth, '--store', 'local', '--storePath', path.join(home, 'store'),
        '--moduleDataPath', path.join(home, 'module_data'), '--loadModule', FIXTURE], {env: {COUNTINGHOUSE_API_KEY: KEY}});
      try {
        await io.request({...INITIALIZE, id: 1});
        const tool = await waitForTool(io, /per_session_module_stateservice_touch$/);
        assert.ok(tool != null, io.err.slice(-2000));
        const r = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {}}});
        assert.strictEqual(r.result && r.result.isError, false, JSON.stringify(r).slice(0, 500));
        assert.strictEqual(fs.readFileSync(path.join(home, 'module_data', NAME, 'data', 'count'), 'utf8'), '1', '<name>/data, as today');
        assert.ok(!fs.existsSync(path.join(home, 'module_data', NAME, 'sessions')), 'no partition under --stdio');
      } finally {
        await io.stop();
      }
    });
  });
});
