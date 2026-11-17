'use strict';
// MCP completeness M10 (spec section 7), over real stdio: the fixture that
// declares everything (test/fixtures/declares-everything) lists its prompt,
// with its arguments derived at load (in a validator in worker mode, on the
// main thread in single-thread mode) and its icon from what the load read
// (M2), and prompts/get answers it with no module code run: the module's
// data directory, where its handlers keep their notes, gets no file.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const {testPort} = require('../helpers/test-env');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'declares-everything');
const KEY = 'stdio-test-key';
const PNG = fs.readFileSync(path.join(FIXTURE, 'icons', 'note.png'));

describe('stdio 30: prompts, spawned (M10)', function() {
  this.timeout(120000);
  const homes = [];
  let io = null;
  afterEach(async () => {
    if (io != null) await io.stop();
    io = null;
  });
  after(() => { for (const h of homes) fs.rmSync(h, {recursive: true, force: true}); });

  for (const workerThread of [true, false]) {
    it(`${workerThread ? 'worker' : 'single-thread'} mode: the fixture's prompt is listed, and got with no module code run`, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-30-'));
      homes.push(home);
      const auth = path.join(home, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
      const data = path.join(home, 'module_data');
      io = startStdio([workerThread ? '--workerThread' : '--no-workerThread', '--loadModule', FIXTURE, '--authConfigPath', auth,
        '--moduleDataPath', data, '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`], {env: {COUNTINGHOUSE_API_KEY: KEY}});
      const init = await io.request({...INITIALIZE, id: 1});
      assert.deepStrictEqual(init.result.capabilities.prompts, {});
      assert.ok(await waitForTool(io, /notesservice_savenote$/) != null, withoutRedisNoise(io.err));
      const list = await io.request({jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {}});
      assert.deepStrictEqual(list.result, {prompts: [{name: 'declares_everything_summarise', title: 'Summarise a note', description: 'Asks for a summary of one saved note.',
        arguments: [{name: 'id', required: true}, {name: 'style', required: false}],
        icons: [{src: `data:image/png;base64,${PNG.toString('base64')}`, mimeType: 'image/png', sizes: ['1x1']}]}]});
      const filesBefore = fs.existsSync(data) ? fs.readdirSync(data, {recursive: true}).length : 0;
      const got = await io.request({jsonrpc: '2.0', id: 3, method: 'prompts/get', params: {name: 'declares_everything_summarise', arguments: {id: 'first', style: 'brief'}}});
      assert.deepStrictEqual(got.result, {description: 'Asks for a summary of one saved note.', messages: [
        {role: 'user', content: {type: 'text', text: 'Summarise the note first in a brief style.'}},
        {role: 'assistant', content: {type: 'text', text: 'Here is the summary of first.'}}
      ]});
      const missing = await io.request({jsonrpc: '2.0', id: 4, method: 'prompts/get', params: {name: 'declares_everything_summarise', arguments: {style: 'brief'}}});
      assert.strictEqual(missing.error && missing.error.code, -32602, JSON.stringify(missing));
      assert.strictEqual(fs.existsSync(data) ? fs.readdirSync(data, {recursive: true}).length : 0, filesBefore, 'no module code ran: nothing was written');
    });
  }
});
