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
      require('../helpers/private-auth').writePrivate(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
      const data = path.join(home, 'module_data');
      io = startStdio([workerThread ? '--workerThread' : '--no-workerThread', '--loadModule', FIXTURE, '--authConfigPath', auth,
        '--moduleDataPath', data, '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`], {env: {COUNTINGHOUSE_API_KEY: KEY}});
      const init = await io.request({...INITIALIZE, id: 1});
      // (a 2025-11-25 stdio client is told its prompts' list changed, as its tools': R-cold-prompts)
      assert.deepStrictEqual(init.result.capabilities.prompts, {listChanged: true});
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

// R-cold-prompts, over real stdio: a client on 2025-11-25 (Claude Code's
// fall-back when its server/discover probe times out on a cold start) that
// listed its prompts before a pack loaded is told notifications/prompts/
// list_changed once the pack's prompt is there; one that never listed its
// prompts is told only of its tools.
describe('stdio 30: a legacy client hears its prompts change (R-cold-prompts)', function() {
  this.timeout(120000);
  const {dirsOf} = require('../helpers/module-dirs');
  const tmp = require('../helpers/test-tmp').forFile(['ch-stdio-30-cold-'], {base: os.tmpdir()});
  let io = null;
  afterEach(async () => {
    if (io != null) await io.stop();
    io = null;
  });
  const messages = () => io.lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((m) => m != null);
  const told = (method) => messages().filter((m) => m.method === method);
  const until = async (test, ms = 15000) => {
    const end = Date.now() + ms;
    while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return test();
  };
  // a pack as ch-local lays it out, with a prompt of its own when asked
  function pack(home, name, prompt) {
    const dir = path.join(home, 'packs', name, '1.0.0', 'node_modules', name);
    const svc = `${name.replace(/[^a-z]/g, '')}Service`;
    const action = `${name.replace(/[^a-z]/g, '')}_hello`;
    fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
    const prompts = prompt ? {promptList: [{name: 'greet', title: 'Greet', description: `a greeting of ${name}`, messages: [{role: 'user', text: 'Say hello.'}]}]} : {};
    fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test', modelDescription: name,
      serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [{name: action, description: `hello of ${name}`, input: {schema: `/${svc}/${action}/input`}, output: {schema: `/${svc}/${action}/output`}}]}}, ...prompts}}));
    fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object', [svc]: {[action]: {input: {type: 'object'}, output: {type: 'object'}}}}));
    fs.writeFileSync(path.join(dir, 'handlers', svc, `${action}.js`), 'module.exports = async () => ({output: {}});\n');
    return dir;
  }
  // a pack whose one action is a resource: a static one (resources/list) or,
  // with a variable in its URI, a template (resources/templates/list)
  function resourcePack(home, name, uriTemplate) {
    const dir = path.join(home, 'packs', name, '1.0.0', 'node_modules', name);
    // (an action name of its own: a pack's tool name may not be another's, a built-in's included)
    const action = `${name.replace(/[^a-z]/g, '')}_status`;
    fs.mkdirSync(path.join(dir, 'handlers', 'packService'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
    fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test', modelDescription: name,
      serviceList: {'urn:countinghouse-test:serviceID:packService': {actionList: [{name: action, description: `the status of ${name}`,
        input: {schema: `/packService/${action}/input`}, output: {schema: `/packService/${action}/output`}, resource: {uriTemplate, name: action}}]}}}}));
    fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
      packService: {[action]: {input: {type: 'object', properties: {id: {type: 'string'}}}, output: {type: 'object'}}}}));
    fs.writeFileSync(path.join(dir, 'handlers', 'packService', `${action}.js`), 'module.exports = async () => ({output: {ok: true}});\n');
    return dir;
  }
  async function started() {
    const home = tmp.mkdtemp('ch-stdio-30-cold-');
    const base = pack(home, 'ch-pack-base', false);
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--modulesRoot', path.join(home, 'packs'), '--loadModule', base], {ipc: true});
    const init = await io.request({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'stdio-30', version: '1.0.0'}}}, 60000);
    assert.deepStrictEqual([init.result.capabilities.prompts, init.result.capabilities.resources], [{listChanged: true}, {listChanged: true}], `${JSON.stringify(init)}\n${io.err.slice(-1500)}`);
    assert.ok(await waitForTool(io, /base_hello$/) != null, io.err.slice(-1500));
    return home;
  }
  async function load(home) {
    const two = pack(home, 'ch-pack-greet', true);
    const r = await io.control({type: 'load', name: 'ch-pack-greet', dirs: dirsOf(two)});
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
  }
  const promptNames = async (id) => (await io.request({jsonrpc: '2.0', id, method: 'prompts/list', params: {}}, 30000)).result.prompts.map((x) => x.name);

  it('a client that listed its prompts before the pack loaded is told prompts/list_changed, in the plain frame, and lists the pack\'s prompt', async () => {
    const home = await started();
    assert.ok(!(await promptNames(2)).some((n) => /greet/.test(n)), 'no prompt of the pack yet');
    await load(home);
    assert.ok(await until(() => told('notifications/prompts/list_changed').length > 0), `no prompts/list_changed\n${io.err.slice(-1500)}`);
    for (const n of told('notifications/prompts/list_changed')) assert.deepStrictEqual(n, {jsonrpc: '2.0', method: 'notifications/prompts/list_changed'}, 'the plain frame');
    assert.ok((await promptNames(3)).some((n) => /greet/.test(n)), 'the pack\'s prompt is listed');
  });

  it('a client that never listed its prompts is told only of its tools', async () => {
    const home = await started();
    await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}, 30000);
    await load(home);
    assert.ok(await until(() => told('notifications/tools/list_changed').length > 0), `no tools/list_changed\n${io.err.slice(-1500)}`);
    // (anything the change sent is written before this answer)
    await io.request({jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}}, 30000);
    assert.deepStrictEqual(told('notifications/prompts/list_changed'), []);
  });

  // each of its resources' lists told on its own: a template's change, then a
  // static resource's (one notice for both lists, so each change by itself
  // pins the list it moves: lib/route-manager.js names each list's field)
  it('a client that listed its resources and their templates is told resources/list_changed for a template, and again for a static resource', async () => {
    const home = await started();
    const RES = 'notifications/resources/list_changed';
    const resources = async (id) => (await io.request({jsonrpc: '2.0', id, method: 'resources/list', params: {}}, 30000)).result.resources.map((r) => r.uri);
    const templates = async (id) => (await io.request({jsonrpc: '2.0', id, method: 'resources/templates/list', params: {}}, 30000)).result.resourceTemplates.map((r) => r.uriTemplate);
    assert.deepStrictEqual([await resources(2), await templates(3)], [[], []]);
    const loadPack = async (name, uriTemplate) => {
      const r = await io.control({type: 'load', name, dirs: dirsOf(resourcePack(home, name, uriTemplate))});
      assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
    };
    await loadPack('ch-pack-tpl', 'notes/{id}');
    assert.ok(await until(() => told(RES).length > 0), `no resources/list_changed for the template\n${io.err.slice(-1500)}`);
    assert.ok((await templates(4)).some((u) => /notes/.test(u)), 'the template is listed');
    const after = told(RES).length;
    await loadPack('ch-pack-res', 'about');
    assert.ok(await until(() => told(RES).length > after), `no resources/list_changed for the static resource\n${io.err.slice(-1500)}`);
    assert.ok((await resources(5)).some((u) => /about/.test(u)), 'the static resource is listed');
    for (const n of told(RES)) assert.deepStrictEqual(n, {jsonrpc: '2.0', method: RES}, 'the plain frame');
  });

  // (a client that sent initialize, then a well-formed 2026-07-28 request,
  // speaks that revision, which tells nothing unasked: as a shared runtime's
  // session, session-list-notices.js. Nothing sent can't be seen, so the
  // check waits well past the change's settle, STDIO_CHANGE_SETTLE_MS in
  // lib/route-manager.js, once the change is seen in its list: it can miss,
  // never fail falsely)
  it('a client that went on in 2026-07-28 after its initialize is told nothing unasked', async () => {
    const home = await started();
    const modern = {_meta: {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}}};
    const names = async (id) => (await io.request({jsonrpc: '2.0', id, method: 'prompts/list', params: modern}, 30000)).result.prompts.map((x) => x.name);
    assert.ok(!(await names(2)).some((n) => /greet/.test(n)));
    await load(home);
    let id = 3;
    const end = Date.now() + 15000;
    let seen = false;
    while (!seen && Date.now() < end) { seen = (await names(id++)).some((n) => /greet/.test(n)); if (!seen) await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(seen, 'the pack\'s prompt is listed');
    await new Promise((r) => setTimeout(r, 2000));
    await io.request({jsonrpc: '2.0', id: id++, method: 'prompts/list', params: modern}, 30000);
    assert.deepStrictEqual([told('notifications/prompts/list_changed'), told('notifications/tools/list_changed')], [[], []]);
  });

  tmp.hooks();
});
