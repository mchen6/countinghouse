// MCP completeness M0: the fixture module that declares everything
// (test/fixtures/declares-everything) is one a real runtime loads and
// serves. Its declarations are checked at the load (stage=declarations);
// nothing serves them yet, so its tools are listed and called as any
// module's. The tasks that serve each part (M2 and on) add to this fixture's
// tests, not to this file. Spawned, --stdio: no port.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');
const {testPort} = require('../helpers/test-env');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'declares-everything');
const KEY = 'stdio-test-key';

describe('--stdio, spawned: the module that declares everything loads and serves (MCP completeness M0)', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  before(() => { home = tmp.mkdtemp('ch-declares-'); });
  after(async () => {
    if (io != null) await io.stop();
    tmp.remove(home);
  });

  it('its tools are listed and called: a plain one, and one whose output declares binary fields', async () => {
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
    io = startStdio(['--workerThread', '--loadModule', FIXTURE, '--authConfigPath', auth,
      '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`], {env: {COUNTINGHOUSE_API_KEY: KEY}});
    const init = await io.request({...INITIALIZE, id: 1});
    assert.ok(init.result != null, JSON.stringify(init));
    // a tool's name is <device>_<service>_<action>, lower-cased
    const save = await waitForTool(io, /notesservice_savenote$/);
    assert.ok(save != null, `the module never listed; stderr without the Redis noise:\n${withoutRedisNoise(io.err)}`);
    const list = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list'});
    const names = list.result.tools.map((t) => t.name).filter((n) => /notesservice_/.test(n)).map((n) => n.replace(/^.*notesservice_/, '')).sort();
    assert.deepStrictEqual(names, ['completeid', 'listnotes', 'readnote', 'rendernote', 'savenote']);
    const call = async (action, args, id) => {
      const tool = list.result.tools.find((t) => t.name.endsWith(`notesservice_${action.toLowerCase()}`));
      const got = await io.request({jsonrpc: '2.0', id: id, method: 'tools/call', params: {name: tool.name, arguments: args}});
      assert.ok(got.result != null && got.result.isError !== true, `${action}: ${JSON.stringify(got)}`);
      return got.result.structuredContent;
    };
    assert.deepStrictEqual(await call('saveNote', {id: 'first', text: 'A first note.'}, 3), {saved: true});
    assert.deepStrictEqual(await call('readNote', {id: 'first'}, 4), {id: 'first', text: 'A first note.'});
    assert.deepStrictEqual(await call('listNotes', {}, 5), {ids: ['first']});
    assert.deepStrictEqual(await call('completeId', {argument: 'id', value: 'fi'}, 6), {values: ['first']});
    const rendered = await call('renderNote', {id: 'first'}, 7);
    assert.strictEqual(Buffer.from(rendered.cover, 'base64').subarray(1, 4).toString('latin1'), 'PNG');
    assert.strictEqual(rendered.pages.length, 1);
  });
});
