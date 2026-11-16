'use strict';
// MCP completeness M7 (spec section 3), over real stdio, in worker and
// single-thread mode: the fixture that declares everything
// (test/fixtures/declares-everything) lists its two resources (notes, a
// static one, and notes/{id}, a template with its icon), and a read runs the
// action as a call does: its input validated by the module's own validators
// (a 65-character id is refused as a call's input would be), a handler's
// error answered -32603 with its code, and a variable the parser refuses
// answered "Resource not found".
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const {testPort} = require('../helpers/test-env');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'declares-everything');
const KEY = 'stdio-test-key';
const PNG = fs.readFileSync(path.join(FIXTURE, 'icons', 'note.png'));
const BASE = 'countinghouse://m/declares_everything';

describe('stdio 31: module resources, spawned (M7)', function() {
  this.timeout(120000);
  const homes = [];
  let io = null;
  afterEach(async () => {
    if (io != null) await io.stop();
    io = null;
  });
  after(() => { for (const h of homes) fs.rmSync(h, {recursive: true, force: true}); });

  for (const workerThread of [true, false]) {
    it(`${workerThread ? 'worker' : 'single-thread'} mode: both lists, and a read run as a call`, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-31-'));
      homes.push(home);
      const auth = path.join(home, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
      io = startStdio([workerThread ? '--workerThread' : '--no-workerThread', '--loadModule', FIXTURE, '--authConfigPath', auth,
        '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`], {env: {COUNTINGHOUSE_API_KEY: KEY}});
      assert.ok((await io.request({...INITIALIZE, id: 1})).result != null);
      const save = await waitForTool(io, /notesservice_savenote$/);
      assert.ok(save != null, withoutRedisNoise(io.err));
      let id = 10;
      const ask = (method, params) => io.request({jsonrpc: '2.0', id: id++, method, params});

      const statics = await ask('resources/list', {});
      // the static resource's description is its action's (it declares none of its own)
      assert.deepStrictEqual(statics.result.resources.map((r) => [r.uri, r.name, typeof r.description]), [[`${BASE}/notes`, 'notes', 'string']]);
      const templates = await ask('resources/templates/list', {});
      assert.deepStrictEqual(templates.result.resourceTemplates, [{uriTemplate: `${BASE}/notes/{id}`, name: 'note', title: 'A note', description: 'One saved note, by its id.',
        mimeType: 'text/markdown', icons: [{src: `data:image/png;base64,${PNG.toString('base64')}`, mimeType: 'image/png'}]}]);

      const saved = await ask('tools/call', {name: save.name, arguments: {id: 'first', text: 'A first note.'}});
      assert.ok(saved.result != null && saved.result.isError !== true, JSON.stringify(saved));
      const note = await ask('resources/read', {uri: `${BASE}/notes/first`});
      assert.deepStrictEqual(note.result.contents, [{uri: `${BASE}/notes/first`, mimeType: 'application/json', text: '{"id":"first","text":"A first note."}'}]);

      const tooLong = await ask('resources/read', {uri: `${BASE}/notes/${'x'.repeat(65)}`});
      assert.strictEqual(tooLong.error && tooLong.error.code, -32603, JSON.stringify(tooLong));
      assert.strictEqual(tooLong.error.data['countinghouse/code'], 'INPUT_DATA_VALIDATION_FAIL', 'the input validated as a call\'s');
      const missing = await ask('resources/read', {uri: `${BASE}/notes/nope`});
      assert.strictEqual(missing.error && missing.error.code, -32603, JSON.stringify(missing));
      assert.strictEqual(typeof missing.error.data['countinghouse/code'], 'string', 'a handler\'s error carries its code');
      for (const uri of [`${BASE}/notes/%2E%2E`, `${BASE}/notes/a%2Fb`, `${BASE}/nothing`, 'countinghouse://m/nobody/notes/first']) {
        const r = await ask('resources/read', {uri});
        assert.deepStrictEqual(r.error, {code: -32602, message: 'Resource not found'}, uri);
      }
    });
  }
});
