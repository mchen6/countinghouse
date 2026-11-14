// countinghouse_settings end to end (packs in place, part 2, plan Task A5):
// a spawned single-identity runtime lists it only with --settingsFile; get
// and a tightening set answer; a loosening is a tool error and changes
// nothing. The rules themselves are stdio 14's (server-free).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

const ROOT = path.join(__dirname, '..', '..');
const MODULE = path.join(ROOT, 'test', 'fixtures', 'handler-map-module');

function start(home, extra = []) {
  return startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--loadModule', MODULE,
    '--moduleDataPath', path.join(home, 'module_data'), ...extra]);
}

describe('stdio 15: countinghouse_settings, spawned', function() {
  this.timeout(60000);
  let home;
  let io = null;
  beforeEach(() => { home = tmp.mkdtemp('ch-settings-'); });
  afterEach(async () => { if (io != null) await io.stop(); io = null; tmp.remove(home); });

  const listed = async () => {
    await waitForTool(io, /hello/);
    const list = await io.request({jsonrpc: '2.0', id: 10, method: 'tools/list', params: {}});
    return list.result.tools.map((t) => t.name);
  };
  const call = (id, args) => io.request({jsonrpc: '2.0', id, method: 'tools/call', params: {name: 'countinghouse_settings', arguments: args}});

  it('without --settingsFile: not listed, and refused by name', async () => {
    io = start(home);
    await io.request({...INITIALIZE, id: 1});
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    assert.ok(!(await listed()).includes('countinghouse_settings'), withoutRedisNoise(io.err));
    const r = await call(2, {action: 'get'});
    assert.strictEqual(r.result.isError, true);
    assert.strictEqual(r.result._meta['countinghouse/code'], 'MODULE_NOT_LISTED');
  });

  it('with --settingsFile: listed; get answers; a tightening set is written; a loosening is refused and changes nothing', async () => {
    const file = path.join(home, 'settings.json');
    io = start(home, ['--settingsFile', file]);
    await io.request({...INITIALIZE, id: 1});
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    assert.ok((await listed()).includes('countinghouse_settings'), withoutRedisNoise(io.err));
    const got = await call(2, {action: 'get'});
    assert.ok(!got.result.isError, JSON.stringify(got.result));
    assert.ok(got.result.structuredContent.settings.some((s) => s.name === 'requestTimeout' && s.value === 30000));
    const set = await call(3, {action: 'set', name: 'requestTimeout', value: '20s'});
    assert.deepStrictEqual(set.result.structuredContent, {name: 'requestTimeout', old: 30000, new: 20000, applies: 'now'});
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).values, {requestTimeout: 20000});
    const loosen = await call(4, {action: 'set', name: 'moduleSandbox', value: 'audit'});
    assert.strictEqual(loosen.result.isError, true);
    assert.strictEqual(loosen.result._meta['countinghouse/code'], 'SETTING_LOOSENS_A_GUARD');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).values, {requestTimeout: 20000});
    const bad = await call(5, {action: 'unset'});
    assert.strictEqual(bad.result._meta['countinghouse/code'], 'ARGUMENTS_INVALID');
    const history = fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(history.map((h) => [h.by, h.setting, h.new]), [['settings tool', 'requestTimeout', 20000]]);
  });
});
