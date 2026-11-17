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
// transport): the bundled modules, the module that declares everything,
// and the fixtures for result shapes (mcp-conformance-module), a question
// (asks-questions), progress (progress-part) and tasks (m15-tasks), with
// --listPageSize 10 so the tools list has pages. The tasks extension's
// results are checked against its own schema (ext-tasks).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const {startStdio, withoutRedisNoise} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

const ROOT = path.join(__dirname, '..', '..');
const FX = path.join(ROOT, 'test', 'fixtures');
const FIXTURES = ['declares-everything', 'mcp-conformance-module', 'asks-questions', 'progress-part', 'm15-tasks'];
const KEY = 'stdio-test-key';
const CORE = require('../fixtures/mcp-schema/2026-07-28/schema.json');
const TASKS = require('../fixtures/mcp-schema/ext-tasks-2026-07-28/schema.json');
const TASKS_EXT = 'io.modelcontextprotocol/tasks';
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': {name: 'conformance', version: '0'}};

const ajv = addFormats(new Ajv2020({strict: false, allErrors: true}));
ajv.addSchema(CORE, 'core');
ajv.addSchema(TASKS, 'tasks');
// `tasks:Name` is the tasks extension's $def, any other the core's
const validatorOf = (def) => {
  const [doc, name] = def.startsWith('tasks:') ? ['tasks', def.slice(6)] : ['core', def];
  const v = ajv.getSchema(`${doc}#/$defs/${name}`);
  assert.ok(v != null, `the schema has no $def ${def}`);
  return v;
};
// a response, as the schema has it: the envelope, then the result as `def`;
// resultType: the kind it must be (a schema alone lets one result shape
// pass for another: an InputRequiredResult's fields are all optional)
function conforms(response, def, resultType = 'complete') {
  const envelope = validatorOf('JSONRPCResultResponse');
  assert.ok(envelope(response), `not a JSONRPCResultResponse: ${ajv.errorsText(envelope.errors)}\n${JSON.stringify(response).slice(0, 800)}`);
  const v = validatorOf(def);
  assert.ok(v(response.result), `not a ${def}: ${ajv.errorsText(v.errors)}\n${JSON.stringify(response.result).slice(0, 1500)}`);
  if (resultType != null) assert.strictEqual(response.result.resultType, resultType, JSON.stringify(response.result).slice(0, 800));
  return response.result;
}
// a notification, as the schema has it: the envelope, then as `def`
function conformsAsNotification(message, def) {
  for (const d of ['JSONRPCNotification', def]) {
    const v = validatorOf(d);
    assert.ok(v(message), `not a ${d}: ${ajv.errorsText(v.errors)}\n${JSON.stringify(message).slice(0, 800)}`);
  }
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
    io = startStdio(['--workerThread', ...modules, ...FIXTURES.flatMap((f) => ['--loadModule', path.join(FX, f)]), '--authConfigPath', auth, '--listPageSize', '10',
      // the local store: results stored past the inline budget, tasks and the
      // used-nonce store need one that answers
      '--store', 'local', '--storePath', path.join(home, 'store'), '--moduleDataPath', path.join(home, 'module_data')], {env: {COUNTINGHOUSE_API_KEY: KEY}});
    // (a scenario's tools are listed by their bare names: asks-questions' probe)
    const wanted = ['notesservice_savenote', 'shapeservice_binary_out', 'probe', 'partservice_work', 'taskservice_slow'];
    let missing = wanted;
    for (let i = 0; i < 120; i++) {
      const tools = await allTools().catch(() => []);
      missing = wanted.filter((n) => !tools.some((t) => t.name === n || t.name.endsWith(`_${n}`)));
      if (missing.length === 0) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`never listed: ${missing.join(', ')}; stderr:\n${withoutRedisNoise(io.err, 1500)}`);
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

  const toolNamed = async (suffix) => (await allTools()).find((t) => t.name === suffix || t.name.endsWith(`_${suffix}`)).name;

  describe('tool results (M3, M4, M5, M20)', () => {
    it('results of every shape are CallToolResults: an object, an array, a string, null, binary values as image, audio and resource blocks, an error', async () => {
      for (const shape of ['object_out', 'array_out', 'string_out', 'number_out', 'null_out', 'binary_whole_out', 'images_array_out', 'no_schema_string', 'no_schema_empty']) {
        conforms(await ask('tools/call', {name: await toolNamed(`shapeservice_${shape}`), arguments: {}}), 'CallToolResult');
      }
      const binary = conforms(await ask('tools/call', {name: await toolNamed('shapeservice_binary_out'), arguments: {}}), 'CallToolResult');
      const kinds = new Set(binary.content.map((c) => c.type));
      assert.ok(kinds.has('image') && kinds.has('audio') && kinds.has('resource'), [...kinds].join(','));
      const failed = conforms(await ask('tools/call', {name: await toolNamed('shapeservice_coded_error'), arguments: {}}), 'CallToolResult');
      assert.strictEqual(failed.isError, true);
    });

    it('a value past the inline budget is a resource_link, and reading it is a ReadResourceResult (M5)', async () => {
      const big = conforms(await ask('tools/call', {name: await toolNamed('shapeservice_big_image_out'), arguments: {}}), 'CallToolResult');
      const link = big.content.find((c) => c.type === 'resource_link');
      assert.ok(link != null, JSON.stringify(big.content.map((c) => c.type)));
      conforms(await ask('resources/read', {uri: link.uri}), 'ReadResourceResult');
    });

    it('an unknown tool is a JSONRPCErrorResponse', async () => {
      conformsAsError(await ask('tools/call', {name: 'no_such_tool', arguments: {}}));
    });
  });

  describe('a module\'s question (M13)', () => {
    it('the pass that asks is an InputRequiredResult; the retry with the answer is a CallToolResult', async () => {
      const name = await toolNamed('probe');
      const FORMS = {elicitation: {form: {}}};
      const asked = conforms(await ask('tools/call', {name, arguments: {what: 'it'}}, FORMS), 'InputRequiredResult', 'input_required');
      const key = Object.keys(asked.inputRequests)[0];
      const done = conforms(await ask('tools/call', {name, arguments: {what: 'it'}, requestState: asked.requestState,
        inputResponses: {[key]: {action: 'accept', content: {yes: true}}}}, FORMS), 'CallToolResult');
      assert.deepStrictEqual(done.structuredContent.answer, {yes: true});
    });
  });

  describe('progress (M9)', () => {
    it('each notifications/progress on the request\'s stream is a ProgressNotification', async () => {
      const token = 'p35';
      const from = io.lines.length;
      conforms(await io.request({jsonrpc: '2.0', id: id++, method: 'tools/call', params: {_meta: Object.assign({}, META, {'io.modelcontextprotocol/clientCapabilities': {}, progressToken: token}),
        name: await toolNamed('partservice_work'), arguments: {}}}, 60000), 'CallToolResult');
      const notes = io.lines.slice(from).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter((m) => m != null && m.method === 'notifications/progress' && m.params != null && m.params.progressToken === token);
      assert.ok(notes.length > 0, 'no progress notification');
      for (const n of notes) conformsAsNotification(n, 'ProgressNotification');
    });
  });

  describe('tasks (M15), against the extension\'s own schema', () => {
    const TASKS_CAPS = {extensions: {[TASKS_EXT]: {}}};
    const task = (method, params) => ask(method, params, TASKS_CAPS);
    it('a task is a CreateTaskResult; tasks/get a GetTaskResult, working then completed; tasks/update and tasks/cancel their results', async () => {
      const made = conforms(await task('tools/call', {name: await toolNamed('taskservice_slow'), arguments: {ms: 400}}), 'tasks:CreateTaskResult', 'task');
      conforms(await task('tasks/get', {taskId: made.taskId}), 'tasks:GetTaskResult');
      let got = null;
      for (let i = 0; i < 100; i++) {
        got = conforms(await task('tasks/get', {taskId: made.taskId}), 'tasks:GetTaskResult');
        if (got.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.strictEqual(got.status, 'completed', JSON.stringify(got));
      conforms(await task('tasks/update', {taskId: made.taskId, inputResponses: {}}), 'tasks:UpdateTaskResult');
      const failing = conforms(await task('tools/call', {name: await toolNamed('taskservice_fails'), arguments: {}}), 'tasks:CreateTaskResult', 'task');
      for (let i = 0; i < 100; i++) {
        got = conforms(await task('tasks/get', {taskId: failing.taskId}), 'tasks:GetTaskResult');
        if (got.status !== 'working') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const long = conforms(await task('tools/call', {name: await toolNamed('taskservice_slow'), arguments: {ms: 5000}}), 'tasks:CreateTaskResult', 'task');
      conforms(await task('tasks/cancel', {taskId: long.taskId}), 'tasks:CancelTaskResult');
      conforms(await task('tasks/get', {taskId: long.taskId}), 'tasks:GetTaskResult');
      conformsAsError(await task('tasks/get', {taskId: `t-${'0'.repeat(32)}`}));
    });
  });
});
