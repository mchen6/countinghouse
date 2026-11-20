'use strict';
// countinghouse_overview end to end (B-firstrun): a spawned single-identity
// runtime with ch-local's install record (modules.json beside the settings
// file) and its held-back list (--heldBackFile, re-read on the control
// message {type: 'reread', what: 'held-back'}). A loaded pack is ready with
// its tools; one held back for a credential names the command, with the
// home's launcher; one turned off is off; any other not loaded gets the
// status hint. It takes no arguments. --heldBackFile without --settingsFile
// is refused at the start.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const {startStdio, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

const ROOT = path.resolve(__dirname, '..', '..');
const SCENARIO = path.join(ROOT, 'test', 'fixtures', 'usage-scenario');

describe('stdio 49: countinghouse_overview, spawned (B-firstrun)', function() {
  this.timeout(60000);
  let home;
  let io = null;
  beforeEach(() => { home = tmp.mkdtemp('ch-overview-'); });
  afterEach(async () => { if (io != null) await io.stop(); io = null; tmp.remove(home); });

  const record = () => fs.writeFileSync(path.join(home, 'modules.json'), JSON.stringify({
    modules: {'usage-scenario': {version: '1.0.0', role: 'scenario'}, 'ch-cred-mod': {version: '1.0.0', role: 'scenario'},
      'ch-off-mod': {version: '1.0.0', role: 'scenario'}, 'ch-other-mod': {version: '1.0.0', role: 'scenario'}},
    packs: {'pack-usage': {modules: {'usage-scenario': '1.0.0'}}, 'pack-cred': {modules: {'ch-cred-mod': '1.0.0'}},
      'pack-off': {modules: {'ch-off-mod': '1.0.0'}}, 'pack-other': {modules: {'ch-other-mod': '1.0.0'}}}}));
  const launcher = () => {
    fs.mkdirSync(path.join(home, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(home, 'bin', 'ch-local.js'), '// the home\'s launcher');
    return path.join(home, 'bin', 'ch-local.js');
  };
  const call = (id, args = {}) => io.request({jsonrpc: '2.0', id, method: 'tools/call', params: {name: 'countinghouse_overview', arguments: args}}, 30000);

  it('the install record and the held-back list: ready, a credential\'s command, off, the status hint; re-read on the control message', async () => {
    record();
    const L = launcher();
    const held = path.join(home, 'held-back.json');
    fs.writeFileSync(held, JSON.stringify({v: 1, modules: [{name: 'ch-cred-mod', reason: 'credential'}, {name: 'ch-off-mod', reason: 'off'}], launcher: L}));
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--settingsFile', path.join(home, 'settings.json'), '--heldBackFile', held,
      '--controlChannel', 'ipc', '--loadModule', SCENARIO], {ipc: true});
    await io.request({...INITIALIZE, id: 1}, 30000);
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    // (the scenario loaded: its tool listed)
    const end = Date.now() + 20000;
    let tools = [];
    while (Date.now() < end) {
      tools = (await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}, 30000)).result.tools.map((t) => t.name);
      if (tools.includes('usage_probe')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(tools.includes('usage_probe'), `${JSON.stringify(tools)} ${withoutRedisNoise(io.err)}`);
    const got = await call(3);
    assert.ok(got.result != null && got.result.isError === false, `${JSON.stringify(got)} ${withoutRedisNoise(io.err)}`);
    const by = Object.fromEntries(got.result.structuredContent.packs.map((p) => [p.name, p]));
    assert.strictEqual(by['pack-usage'].state, 'ready');
    assert.deepStrictEqual(by['pack-usage'].tools.slice().sort(), ['usage_probe', 'usage_reserved'], JSON.stringify(by['pack-usage']));
    assert.deepStrictEqual([by['pack-cred'].state, by['pack-cred'].next], ['not loaded', `In your own terminal run \`node "${L}" credentials add ch-cred-mod\`.`]);
    assert.deepStrictEqual([by['pack-off'].state, by['pack-off'].next], ['off', undefined]);
    assert.strictEqual(by['pack-other'].next, `Not loaded: run \`node "${L}" status\` in your own terminal to see why.`);
    assert.strictEqual(got.result.content[0].type, 'text');
    assert.ok(got.result.content[0].text.includes('pack-cred (not loaded)'), got.result.content[0].text);
    // ch-local's applier saw a credential added and the module turned on: the file again
    fs.writeFileSync(held, JSON.stringify({v: 1, modules: [{name: 'ch-off-mod', reason: 'off'}], launcher: L}));
    const reply = await io.control({type: 'reread', what: 'held-back'});
    assert.strictEqual(reply.ok, true, JSON.stringify(reply));
    const again = (await call(4)).result.structuredContent.packs.find((p) => p.name === 'pack-cred');
    assert.strictEqual(again.next, `Not loaded: run \`node "${L}" status\` in your own terminal to see why.`);
    // one that cannot be read: refused, and the list empty (never "all ready")
    fs.writeFileSync(held, '{');
    const bad = await io.control({type: 'reread', what: 'held-back'});
    assert.deepStrictEqual([bad.ok, bad.code], [false, 'CONTROL_FAILED'], JSON.stringify(bad));
    const off = (await call(5)).result.structuredContent.packs.find((p) => p.name === 'pack-off');
    assert.strictEqual(off.state, 'not loaded', 'with no list a pack not loaded is only that');
  });

  it('takes no arguments', async () => {
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data')]);
    await io.request({...INITIALIZE, id: 1}, 30000);
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    const r = await call(2, {packs: 'all'});
    assert.strictEqual(r.result.isError, true, JSON.stringify(r));
    assert.strictEqual(r.result._meta['countinghouse/code'], 'ARGUMENTS_INVALID');
    const none = await call(3);
    assert.ok(none.result.content[0].text.includes('No packs are installed.'), none.result.content[0].text);
  });

  it('--heldBackFile without --settingsFile is refused at the start (exit 2), never ignored', () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--stdio',
      '--heldBackFile', path.join(home, 'held-back.json')], {encoding: 'utf8', timeout: 30000, input: ''});
    assert.strictEqual(run.status, 2, run.stderr);
    assert.match(run.stderr, /--heldBackFile is only with --settingsFile/);
  });
});
