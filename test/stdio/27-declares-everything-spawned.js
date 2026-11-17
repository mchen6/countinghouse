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
    // its two resource actions (readNote, listNotes) are not tools (M7): they are read as resources
    assert.deepStrictEqual(names, ['completeid', 'rendernote', 'savenote']);
    const call = async (action, args, id) => {
      const tool = list.result.tools.find((t) => t.name.endsWith(`notesservice_${action.toLowerCase()}`));
      const got = await io.request({jsonrpc: '2.0', id: id, method: 'tools/call', params: {name: tool.name, arguments: args}});
      assert.ok(got.result != null && got.result.isError !== true, `${action}: ${JSON.stringify(got)}`);
      return got.result;
    };
    const answer = async (action, args, id) => (await call(action, args, id)).structuredContent;
    assert.deepStrictEqual(await answer('saveNote', {id: 'first', text: 'A first note.'}, 3), {saved: true});
    const readResource = async (uri, id) => {
      const got = await io.request({jsonrpc: '2.0', id: id, method: 'resources/read', params: {uri}});
      assert.ok(got.result != null, `${uri}: ${JSON.stringify(got)}`);
      return got.result.contents;
    };
    const note = await readResource('countinghouse://m/declares_everything/notes/first', 4);
    assert.deepStrictEqual(note.map((c) => [c.uri, c.mimeType]), [['countinghouse://m/declares_everything/notes/first', 'application/json']]);
    assert.deepStrictEqual(JSON.parse(note[0].text), {id: 'first', text: 'A first note.'});
    assert.deepStrictEqual(JSON.parse((await readResource('countinghouse://m/declares_everything/notes', 5))[0].text), {ids: ['first']});
    assert.deepStrictEqual(await answer('completeId', {argument: 'id', value: 'fi'}, 6), {values: ['first']});
    // its binary fields are served as M4 serves any: an image block each, and a reference in their place
    const rendered = await call('renderNote', {id: 'first'}, 7);
    const {cover, pages} = rendered.structuredContent;
    assert.deepStrictEqual([cover.mimeType, pages.length, pages[0].mimeType], ['image/png', 1, 'image/jpeg']);
    const block = rendered.content[cover.block];
    assert.deepStrictEqual([block.type, block.mimeType], ['image', 'image/png']);
    const bytes = Buffer.from(block.data, 'base64');
    assert.strictEqual(bytes.subarray(1, 4).toString('latin1'), 'PNG');
    assert.strictEqual(cover.bytes, bytes.length);
    assert.strictEqual(rendered.content[pages[0].block].type, 'image');
  });
});
