'use strict';
// MCP completeness M18, the conformance sweep for 2026-07-28 clients. No SDK
// speaks this revision yet, so the oracle is its official JSON Schema
// (test/fixtures/mcp-schema, vendored at a pinned commit; never loaded at
// runtime): every response is checked against JSONRPCResultResponse or
// JSONRPCErrorResponse, and its result against the $def its method names.
// One feature per describe, each once it is on master; the legacy era's
// conformance is the SDK client's (mcp-contract 03, 36).
//
// Spawned, --stdio (the schema's concern is the message, not the
// transport): the bundled modules and the module that declares everything,
// with --listPageSize 10 so the tools list has pages.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const {startStdio, withoutRedisNoise} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');
const {testPort} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'declares-everything');
const KEY = 'stdio-test-key';
const CORE = require('../fixtures/mcp-schema/2026-07-28/schema.json');
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': {name: 'conformance', version: '0'}};

const ajv = addFormats(new Ajv2020({strict: false, allErrors: true}));
ajv.addSchema(CORE, 'core');
const validatorOf = (def) => {
  const v = ajv.getSchema(`core#/$defs/${def}`);
  assert.ok(v != null, `the schema has no $def ${def}`);
  return v;
};
// a response, as the schema has it: the envelope, then the result as `def`
function conforms(response, def) {
  const envelope = validatorOf('JSONRPCResultResponse');
  assert.ok(envelope(response), `not a JSONRPCResultResponse: ${ajv.errorsText(envelope.errors)}\n${JSON.stringify(response).slice(0, 800)}`);
  const v = validatorOf(def);
  assert.ok(v(response.result), `not a ${def}: ${ajv.errorsText(v.errors)}\n${JSON.stringify(response.result).slice(0, 1500)}`);
  return response.result;
}
function conformsAsError(response) {
  const v = validatorOf('JSONRPCErrorResponse');
  assert.ok(v(response), `not a JSONRPCErrorResponse: ${ajv.errorsText(v.errors)}\n${JSON.stringify(response).slice(0, 800)}`);
  return response.error;
}

describe('mcp-contract 35: what a 2026-07-28 client is sent conforms to the official schema (M18)', function() {
  this.timeout(180000);
  let home = null;
  let io = null;
  let id = 1;
  const ask = (method, params = {}, caps = {}) => io.request({jsonrpc: '2.0', id: id++, method,
    params: Object.assign({_meta: Object.assign({}, META, {'io.modelcontextprotocol/clientCapabilities': caps})}, params)}, 60000);
  const allTools = async () => {
    const tools = [];
    let cursor;
    for (let page = 0; page < 50; page++) {
      const r = conforms(await ask('tools/list', cursor != null ? {cursor} : {}), 'ListToolsResult');
      tools.push(...r.tools);
      if (r.nextCursor == null) return tools;
      cursor = r.nextCursor;
    }
    throw new Error('the tools list never ended');
  };

  before(async () => {
    home = tmp.mkdtemp('ch-mcp-35-');
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
    const pre = path.join(ROOT, 'pre-installed-packages');
    const modules = fs.readdirSync(pre).filter((d) => fs.statSync(path.join(pre, d)).isDirectory()).flatMap((d) => ['--loadModule', path.join(pre, d)]);
    io = startStdio(['--workerThread', ...modules, '--loadModule', FIXTURE, '--authConfigPath', auth, '--listPageSize', '10',
      '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', `redis://127.0.0.1:${testPort(9756)}`], {env: {COUNTINGHOUSE_API_KEY: KEY}});
    for (let i = 0; i < 120; i++) {
      const tools = await allTools().catch(() => []);
      if (tools.some((t) => /notesservice_savenote$/.test(t.name))) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`the module never listed; stderr:\n${withoutRedisNoise(io.err)}`);
  });
  after(async () => {
    if (io != null) await io.stop();
    if (home != null) tmp.remove(home);
  });

  describe('discovery (#229)', () => {
    it('server/discover is a DiscoverResult', async () => {
      conforms(await ask('server/discover'), 'DiscoverResult');
    });
  });

  describe('pagination (M1) and tool metadata (M2)', () => {
    it('each tools/list page is a ListToolsResult; the cursors run to the end and list every tool once', async () => {
      const tools = await allTools();
      assert.ok(tools.length > 10, `${tools.length} tools: not more than one page`);
      assert.strictEqual(new Set(tools.map((t) => t.name)).size, tools.length, 'a tool listed twice');
    });

    it('a tool with a title, annotations and icons is a Tool (each in ListToolsResult)', async () => {
      const save = (await allTools()).find((t) => /notesservice_savenote$/.test(t.name));
      assert.ok(save.title != null && save.annotations != null && Array.isArray(save.icons), JSON.stringify(save).slice(0, 400));
      const v = validatorOf('Tool');
      assert.ok(v(save), ajv.errorsText(v.errors));
    });

    it('a cursor that is not one of ours is a JSONRPCErrorResponse', async () => {
      const e = conformsAsError(await ask('tools/list', {cursor: 'not-a-cursor'}));
      assert.strictEqual(e.code, -32602);
    });
  });

  describe('resources (M7)', () => {
    it('resources/list, resources/templates/list and resources/read', async () => {
      const listed = conforms(await ask('resources/list'), 'ListResourcesResult');
      const templates = conforms(await ask('resources/templates/list'), 'ListResourceTemplatesResult');
      assert.ok(listed.resources.length > 0 && templates.resourceTemplates.length > 0);
      const notes = listed.resources.find((r) => /\/notes$/.test(r.uri));
      conforms(await ask('resources/read', {uri: notes.uri}), 'ReadResourceResult');
      // one that is not there
      conformsAsError(await ask('resources/read', {uri: 'countinghouse://m/declares_everything/nowhere'}));
    });
  });

  describe('prompts and completion (M10, M11)', () => {
    it('prompts/list, prompts/get and completion/complete', async () => {
      const prompts = conforms(await ask('prompts/list'), 'ListPromptsResult').prompts;
      const summarise = prompts.find((p) => /summarise$/.test(p.name));
      conforms(await ask('prompts/get', {name: summarise.name, arguments: {id: 'first', style: 'short'}}), 'GetPromptResult');
      conforms(await ask('completion/complete', {ref: {type: 'ref/prompt', name: summarise.name}, argument: {name: 'style', value: ''}}), 'CompleteResult');
      conformsAsError(await ask('prompts/get', {name: 'no_such_prompt', arguments: {}}));
    });
  });

  describe('tool calls', () => {
    it('a tool\'s result is a CallToolResult; one that asks (form elicitation declared) is an InputRequiredResult', async () => {
      const tools = await allTools();
      const render = tools.find((t) => /notesservice_rendernote$/.test(t.name));
      const save = tools.find((t) => /notesservice_savenote$/.test(t.name));
      conforms(await ask('tools/call', {name: save.name, arguments: {id: 'c35', text: 'a note'}}), 'CallToolResult');
      conforms(await ask('tools/call', {name: render.name, arguments: {id: 'c35'}}), 'CallToolResult');
      // saving over it asks first
      conforms(await ask('tools/call', {name: save.name, arguments: {id: 'c35', text: 'again'}}, {elicitation: {form: {}}}), 'InputRequiredResult');
      conformsAsError(await ask('tools/call', {name: 'no_such_tool', arguments: {}}));
    });
  });
});
