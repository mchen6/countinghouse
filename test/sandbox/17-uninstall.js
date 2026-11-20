// POST /uninstall-module {name, keepData} (part 2 spec, section 7): a module's
// data and registry entry, never its code; refused while the module is
// loaded, restarting or suspended; deletion under the module's lifecycle lock.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {mkdtemp} = require('../helpers/test-tmp');
const {toolOutput} = require('../helpers/tool-result');

const PORT = testPort(9635);
const KEY = 'k';
const PROBE = path.join(ROOT, 'test', 'fixtures', 'fs-probe');
const tool = (a) => `fs_probe_probeservice_${a}`;

describe('sandbox 17: POST /uninstall-module', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  let outside = null;
  afterEach(() => {
    stopServer(server);
    server = null;
    [base, outside].forEach((d) => d && fs.rmSync(d, {recursive: true, force: true}));
    base = outside = null;
  });

  const store = () => path.join(base, 'store');
  const start = (mode, env) => {
    base = mkdtemp('uninstall-');
    return startServer(PORT, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', mode || 'audit',
      '--moduleDataPath', store(), '--loadModule', PROBE], env != null ? {env: env} : {});
  };
  const uninstall = (body, key) => post(PORT, key || KEY, '/uninstall-module', body);

  it('refuses while the module is loaded', async () => {
    server = await start();
    await mcpCall(PORT, KEY, tool('write'), {path: '/data/x', content: 'x'});
    const r = await uninstall({name: 'fs-probe'});
    assert.strictEqual(r.body.code, 'MODULE_LOADED', JSON.stringify(r.body));
    assert.strictEqual(fs.readFileSync(path.join(store(), 'fs-probe', 'data', 'x'), 'utf8'), 'x');
  });

  it('after an unload, deletes the data; keepData keeps it; the code is never touched', async () => {
    server = await start();
    await mcpCall(PORT, KEY, tool('write'), {path: '/data/x', content: 'x'});
    assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'fs-probe'})).status, 200);
    const kept = await uninstall({name: 'fs-probe', keepData: true});
    assert.strictEqual(kept.status, 200, JSON.stringify(kept.body));
    assert.strictEqual(kept.body.dataDeleted, false);
    assert.strictEqual(fs.existsSync(path.join(store(), 'fs-probe', 'data', 'x')), true);
    const gone = await uninstall({name: 'fs-probe'});
    assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
    assert.deepStrictEqual({deleted: gone.body.dataDeleted, registry: gone.body.registryEntryRemoved, kept: gone.body.kept}, {deleted: true, registry: false, kept: []});
    assert.strictEqual(fs.existsSync(path.join(store(), 'fs-probe')), false);
    assert.strictEqual(fs.existsSync(path.join(PROBE, 'package.json')), true);
  });

  // A-overlap-rm: the uninstall removes only what the runtime made
  // (lib/data-ownership.js). A data directory from before ownership marks,
  // holding another module's code (one the runtime knows: it is loaded from
  // there), is never adopted, so it survives, and the answer names it.
  it('another module\'s code under a data directory the runtime did not make survives the uninstall, named in kept', async () => {
    base = mkdtemp('uninstall-');
    const data = path.join(store(), 'fs-probe', 'data');
    const peer = path.join(data, 'peer');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'isolation-peer'), peer, {recursive: true});
    server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', 'audit',
      '--moduleDataPath', store(), '--loadModule', PROBE, '--loadModule', peer]);
    assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'fs-probe'})).status, 200);
    const r = await uninstall({name: 'fs-probe'});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual({deleted: r.body.dataDeleted, kept: r.body.kept}, {deleted: false, kept: [data]});
    assert.ok(fs.existsSync(path.join(peer, 'package.json')), 'the other module\'s code survives');
    assert.strictEqual(fs.existsSync(path.join(store(), 'fs-probe', 'tmp')), false, 'its tmp, which the runtime made, is removed');
    assert.match(server.output, /fs-probe.*data was not made by this runtime \(no ownership mark for it\), so it is not removed/);
  });

  // the reviewer's high on #467, round 3, 1: an @scope that is a link is
  // refused before anything under it is touched -- its target's partitions
  // and stray files included
  it('an @scope that is a link: the uninstall is refused, and nothing under its target is touched', async () => {
    server = await start();
    const target = path.join(base, 'elsewhere');
    const p = path.join(target, 'p');
    const id = 'a'.repeat(32);
    fs.mkdirSync(path.join(p, 'data'), {recursive: true});
    fs.mkdirSync(path.join(p, 'sessions', id, 'data'), {recursive: true});
    fs.writeFileSync(path.join(p, 'sessions', 'stray'), 'keep');
    fs.writeFileSync(path.join(p, 'sessions', id, 'data', 'f'), 'keep');
    fs.symlinkSync(target, path.join(store(), '@fake'), 'junction');
    const r = await uninstall({name: '@fake/p'});
    assert.strictEqual(r.body.code, 'MODULE_DATA_NOT_DIRECTORY', JSON.stringify(r.body));
    for (const f of [path.join(p, 'sessions', 'stray'), path.join(p, 'sessions', id, 'data', 'f')]) assert.ok(fs.existsSync(f), `${f} removed through the link`);
  });

  it('refuses a name that is not a package name, before building any path', async () => {
    server = await start();
    for (const name of ['../x', 'a/b/c', '', '..']) {
      const r = await uninstall({name: name});
      assert.strictEqual(r.body.code, 'MODULE_NAME_INVALID', `${JSON.stringify(name)}: ${JSON.stringify(r.body)}`);
    }
    assert.strictEqual(fs.existsSync(path.join(store(), 'fs-probe')), true);
  });

  it('never follows a link: a data root that is a symlink is refused and its target kept', async () => {
    server = await start();
    outside = fs.mkdtempSync(path.join(os.homedir(), '.ch-uninstall-outside-'));
    fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    fs.symlinkSync(outside, path.join(store(), 'ghost'));
    const r = await uninstall({name: 'ghost'});
    assert.strictEqual(r.body.code, 'MODULE_DATA_NOT_DIRECTORY', JSON.stringify(r.body));
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
  });

  it('a scoped name: deletes <store>/@scope/name and the empty scope directory (review M2)', async () => {
    server = await start();
    // (made as the runtime makes a module's data, so its own: A-overlap-rm)
    await require('../../lib/module-data').ensureDirs(store(), '@scope/probe');
    fs.writeFileSync(path.join(store(), '@scope', 'probe', 'data', 'x'), 'x');
    const r = await uninstall({name: '@scope/probe'});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(fs.existsSync(path.join(store(), '@scope')), false);
  });

  it('unload, then uninstall while the old broker is still settling: waits, then succeeds (review I5)', async () => {
    server = await start('audit', {COUNTINGHOUSE_TEST_BROKER_DELAY_MS: '1500'});
    assert.deepStrictEqual(toolOutput(await mcpCall(PORT, KEY, tool('slowwrite'), {})), {ok: true, code: null});
    assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'fs-probe'})).status, 200);
    const r = await uninstall({name: 'fs-probe'});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.dataDeleted, true);
    assert.strictEqual(fs.existsSync(path.join(store(), 'fs-probe')), false);
  });

  it('refuses while the module is restarting', async () => {
    server = await start('audit');
    assert.deepStrictEqual(toolOutput(await mcpCall(PORT, KEY, tool('exit'), {})), {ok: true, code: null});
    await waitFor(async () => server.output.includes('restarting in'), 15000, 'supervisor restarting');
    const r = await uninstall({name: 'fs-probe'});
    assert.strictEqual(r.body.code, 'MODULE_LOADED', JSON.stringify(r.body));
    assert.ok(/restarting/.test(r.body.message), r.body.message);
  });

  it('a load racing the uninstall: either the uninstall is refused, or the load sees empty data', async () => {
    server = await start();
    await mcpCall(PORT, KEY, tool('write'), {path: '/data/x', content: 'x'});
    assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'fs-probe'})).status, 200);
    const [load, un] = await Promise.all([post(PORT, KEY, '/load-module', {path: PROBE, name: 'fs-probe'}), uninstall({name: 'fs-probe'})]);
    assert.strictEqual(load.status, 200, JSON.stringify(load.body));
    assert.ok(un.status === 200 || un.body.code === 'MODULE_LOADED', JSON.stringify(un.body));
    // The module's tools appear once its device comes online, just after the load answers.
    let r = null;
    await waitFor(async () => { r = await mcpCall(PORT, KEY, tool('read'), {path: '/data/x'}); return r.isError === false; }, 15000, 'module online');
    const expected = un.status === 200 ? {content: null, code: 'ENOENT'} : {content: 'x', code: null};
    assert.deepStrictEqual(toolOutput(r), expected, JSON.stringify({un: un.body, r}));
  });

  // Registry mode (no --loadModule): the entry is removed, and reported only
  // when there was one (plan 4 follow-up; carried to plan 5).
  it('registry mode: removes the registry entry and says whether there was one', async function() {
    let sqlite3 = null;
    try { sqlite3 = require('sqlite3'); } catch (e) { return this.skip(); }
    base = mkdtemp('uninstall-');
    const modulesDir = path.join(base, 'modules');
    fs.mkdirSync(modulesDir);
    // the registry is opt-in (--moduleRegistry): this case tests it on purpose
    server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', 'audit',
      '--modulePath', modulesDir, '--moduleDataPath', store(), '--moduleRegistry']);
    const db = new sqlite3.Database(path.join(modulesDir, 'countinghouse-modules.db'));
    await new Promise((resolve, reject) => db.run("CREATE TABLE IF NOT EXISTS module_info(name TEXT PRIMARY KEY, version TEXT, path TEXT, deviceList TEXT)",
      (e) => (e ? reject(e) : db.run("INSERT INTO module_info(name, version, path, deviceList) VALUES ('ghost-mod', '1.0.0', '/nonexistent', '[]')",
        (e2) => (e2 ? reject(e2) : resolve())))));
    await new Promise((resolve) => db.close(resolve));
    // (by hand, as an install before ownership marks left it: adopted by the
    // uninstall, no module's code being in or around it -- A-overlap-rm)
    fs.mkdirSync(path.join(store(), 'ghost-mod', 'data'), {recursive: true});
    const first = await uninstall({name: 'ghost-mod'});
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.deepStrictEqual({removed: first.body.registryEntryRemoved, deleted: first.body.dataDeleted}, {removed: true, deleted: true});
    const second = await uninstall({name: 'ghost-mod'});
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.deepStrictEqual({removed: second.body.registryEntryRemoved, deleted: second.body.dataDeleted}, {removed: false, deleted: false});
  });

  it('needs an admin key', async () => {
    base = mkdtemp('uninstall-');
    const auth = path.join(base, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({'admin-key': {userName: 'admin', devices: [], admin: true}, 'user-key': {userName: 'user', devices: []}}));
    server = await startServer(PORT, ['--workerThread', '--moduleSandbox', 'audit', '--authConfigPath', auth,
      '--moduleDataPath', store(), '--loadModule', PROBE]);
    assert.strictEqual((await post(PORT, 'admin-key', '/unload-module', {name: 'fs-probe'})).status, 200);
    // Exactly what the existing admin-only routes answer a non-admin key.
    const reference = await post(PORT, 'user-key', '/restart-module', {name: 'fs-probe'});
    assert.notStrictEqual(reference.status, 200, JSON.stringify(reference.body));
    const r = await uninstall({name: 'fs-probe'}, 'user-key');
    assert.deepStrictEqual({status: r.status, code: r.body.code}, {status: reference.status, code: reference.body.code}, JSON.stringify(r.body));
    assert.strictEqual(fs.existsSync(path.join(store(), 'fs-probe')), true);
  });
});
