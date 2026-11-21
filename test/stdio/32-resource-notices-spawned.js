'use strict';
// MCP completeness M8 (spec section 3), over real stdio: a 2026-07-28 client's
// subscriptions/listen agrees to resourcesListChanged, promptsListChanged and
// the resource URIs it may read, at most 64, in the order asked (anything
// else is left out of the acknowledgement's filter). A successful call to an
// action a subscribed resource lists in changesWith (here, or through a hop)
// sends notifications/resources/updated for each such URI, once per settle;
// a call that fails, or is refused before its handler, sends none. discover
// says so.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, MODERN_META} = require('../helpers/stdio-client');
const {testPort} = require('../helpers/test-env');

const NOTES = path.join(__dirname, '..', 'fixtures', 'notes-notices');
const EDITOR = path.join(__dirname, '..', 'fixtures', 'notes-editor');
const KEY = 'stdio-test-key';
const BASE = 'countinghouse://m/notes_notices';
const SUB = 'io.modelcontextprotocol/subscriptionId';

// A pack's scenario as ch-local lays it out (<packs>/<name>/<version>/
// node_modules/<name>): a static resource and a prompt of its own.
function packWithResource(home, name) {
  const dir = path.join(home, 'packs', name, '1.0.0', 'node_modules', name);
  fs.mkdirSync(path.join(dir, 'handlers', 'packService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test', modelDescription: name,
    serviceList: {'urn:countinghouse-test:serviceID:packService': {actionList: [{name: 'status', description: `the status of ${name}`,
      output: {schema: '/packService/status/output'}, resource: {uriTemplate: 'status', name: 'status'}}]}},
    promptList: [{name: `${name.replace(/-/g, '_')}_ask`, description: 'Asks.', arguments: {schema: '/prompts/ask'}, messages: [{role: 'user', text: '{{q}}'}]}]}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    packService: {status: {output: {type: 'object'}}}, prompts: {ask: {type: 'object', properties: {q: {type: 'string'}}, required: ['q']}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'packService', 'status.js'), 'module.exports = async () => ({output: {ok: true}});\n');
  return dir;
}

const {dirsOf} = require('../helpers/module-dirs');

describe('stdio 32: resource and prompt notices on a listen, spawned (M8)', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  afterEach(async () => {
    if (io != null) await io.stop();
    io = null;
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
    home = null;
  });
  const messages = () => io.lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((m) => m != null);
  const until = async(test, ms = 15000) => {
    const end = Date.now() + ms;
    while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return test();
  };
  const updates = (sub) => messages().filter((m) => m.method === 'notifications/resources/updated' && m.params._meta[SUB] === sub).map((m) => m.params.uri);
  const ackOf = (sub) => messages().find((m) => m.method === 'notifications/subscriptions/acknowledged' && m.params._meta[SUB] === sub);
  const quiet = () => new Promise((r) => setTimeout(r, 800));

  it('discover offers them; a listen agrees to readable URIs only; a successful call (direct or by a hop) is announced per URI, once per settle', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-32-'));
    const auth = path.join(home, 'auth.json');
    // (notes-editor composes: its hop runs as the identity bound to it)
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']},
      'notes-editor-internal': {userName: 'notes-editor-internal', devices: ['*'], runsModules: ['notes-editor']}}), {mode: 0o600});
    io = startStdio(['--workerThread', '--loadModule', NOTES, '--loadModule', EDITOR, '--authConfigPath', auth,
      '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`], {env: {COUNTINGHOUSE_API_KEY: KEY}});
    let id = 1;
    const ask = (method, params = {}) => io.request({jsonrpc: '2.0', id: id++, method, params: Object.assign({_meta: MODERN_META}, params)});
    const discover = await ask('server/discover');
    assert.deepStrictEqual([discover.result.capabilities.resources, discover.result.capabilities.prompts],
      [{listChanged: true, subscribe: true}, {listChanged: true}], JSON.stringify(discover));
    const save = await waitForTool(io, /notesservice_save$/);
    const fail = await waitForTool(io, /notesservice_fail$/);
    const edit = await waitForTool(io, /editorservice_edit$/);
    if (save == null || fail == null || edit == null) {
      const listed = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/list'});
      assert.fail(`tools listed: ${JSON.stringify(((listed.result && listed.result.tools) || []).map((t) => t.name))}\n${withoutRedisNoise(io.err).slice(-1500)}`);
    }

    // what is agreed: the readable URIs, in order, at most 64
    const many = [];
    for (let i = 0; i < 70; i++) many.push(`${BASE}/notes/n${i}`);
    const asked = [`${BASE}/notes/a`, 'countinghouse://m/nobody/notes/a', `${BASE}/about`, `${BASE}/nothing`, `${BASE}/notes/${'x'.repeat(3000)}`,
      'https://example.invalid/notes/a', 7].concat(many);
    io.notify({jsonrpc: '2.0', id: 100, method: 'subscriptions/listen', params: {_meta: MODERN_META,
      notifications: {resourcesListChanged: true, promptsListChanged: true, resourceSubscriptions: asked}}});
    assert.ok(await until(() => ackOf(100) != null), withoutRedisNoise(io.err).slice(-1500));
    assert.deepStrictEqual(ackOf(100).params.notifications, {resourcesListChanged: true, promptsListChanged: true,
      resourceSubscriptions: [`${BASE}/notes/a`, `${BASE}/about`].concat(many.slice(0, 62))});
    io.notify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 100}});

    // the listen the rest uses
    io.notify({jsonrpc: '2.0', id: 101, method: 'subscriptions/listen', params: {_meta: MODERN_META,
      notifications: {resourceSubscriptions: [`${BASE}/notes/a`, `${BASE}/about`, `${BASE}/notes/b`]}}});
    assert.ok(await until(() => ackOf(101) != null));

    // a save: notes/a and about (both list save), not notes/b... which is
    // notes/{id} too: every subscribed URI of the resource
    const call = (tool, args) => ask('tools/call', {name: tool.name, arguments: args});
    const saved = await call(save, {id: 'a', text: 'A.'});
    assert.ok(saved.result != null && saved.result.isError !== true, JSON.stringify(saved));
    assert.ok(await until(() => updates(101).length >= 3), JSON.stringify(updates(101)));
    await quiet();
    assert.deepStrictEqual(updates(101).sort(), [`${BASE}/about`, `${BASE}/notes/a`, `${BASE}/notes/b`]);

    // two saves within one settle: one notice per URI
    await Promise.all([call(save, {id: 'a', text: 'A2.'}), call(save, {id: 'b', text: 'B.'})]);
    assert.ok(await until(() => updates(101).length >= 6));
    await quiet();
    assert.strictEqual(updates(101).length, 6, JSON.stringify(updates(101)));

    // a call that fails (its handler throws) and one refused before its
    // handler (input invalid): nothing
    const failed = await call(fail, {id: 'a'});
    assert.ok(failed.result != null && failed.result.isError === true, JSON.stringify(failed));
    const refused = await call(save, {id: 'a'});
    assert.ok((refused.result != null && refused.result.isError === true) || refused.error != null, JSON.stringify(refused));
    await quiet();
    assert.strictEqual(updates(101).length, 6, `a failed or refused call was announced: ${JSON.stringify(updates(101))}`);

    // through a hop: notes-editor's edit saves in notes-notices
    const edited = await call(edit, {id: 'a', text: 'A3.'});
    assert.ok(edited.result != null && edited.result.isError !== true, JSON.stringify(edited));
    assert.ok(await until(() => updates(101).length >= 9), JSON.stringify(updates(101)));
    await quiet();
    assert.strictEqual(updates(101).length, 9);
    // never anything unasked on the cancelled listen
    assert.deepStrictEqual(updates(100), []);
  });

  it('a pack loaded in place, and unloaded, moves the resource and prompt lists: each list_changed once, to the listen that asked, and the tools list not', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-32-'));
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--modulesRoot', path.join(home, 'packs'), '--loadModule', NOTES], {ipc: true});
    const first = await io.request({jsonrpc: '2.0', id: 1, method: 'resources/list', params: {_meta: MODERN_META}}, 60000);
    assert.ok(first.result != null, `${JSON.stringify(first)}\n${io.err.slice(-1500)}`);
    io.notify({jsonrpc: '2.0', id: 200, method: 'subscriptions/listen', params: {_meta: MODERN_META, notifications: {resourcesListChanged: true, promptsListChanged: true}}});
    io.notify({jsonrpc: '2.0', id: 201, method: 'subscriptions/listen', params: {_meta: MODERN_META, notifications: {toolsListChanged: true}}});
    assert.ok(await until(() => ackOf(200) != null && ackOf(201) != null), io.err.slice(-1500));
    const of = (sub, method) => messages().filter((m) => m.method === method && m.params._meta[SUB] === sub).length;
    const loaded = await io.control({type: 'load', name: 'ch-pack-status', dirs: dirsOf(packWithResource(home, 'ch-pack-status'))});
    assert.strictEqual(loaded.ok, true, `${JSON.stringify(loaded)}\n${io.err.slice(-2000)}`);
    assert.ok(await until(() => of(200, 'notifications/resources/list_changed') === 1 && of(200, 'notifications/prompts/list_changed') === 1),
      JSON.stringify(messages().filter((m) => m.method != null && m.method.startsWith('notifications/'))));
    await quiet();
    assert.deepStrictEqual([of(200, 'notifications/resources/list_changed'), of(200, 'notifications/prompts/list_changed'), of(200, 'notifications/tools/list_changed')], [1, 1, 0]);
    // the tools' listen hears its own list only, which did not move (the
    // pack's one action is a resource, never also a tool)
    assert.deepStrictEqual([of(201, 'notifications/tools/list_changed'), of(201, 'notifications/resources/list_changed'),
      of(201, 'notifications/prompts/list_changed')], [0, 0, 0]);
    const unloaded = await io.control({type: 'unload', name: 'ch-pack-status'});
    assert.strictEqual(unloaded.ok, true, JSON.stringify(unloaded));
    assert.ok(await until(() => of(200, 'notifications/resources/list_changed') === 2 && of(200, 'notifications/prompts/list_changed') === 2));
  });
});
