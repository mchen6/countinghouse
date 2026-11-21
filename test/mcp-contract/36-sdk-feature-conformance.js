'use strict';
// MCP completeness M18, the conformance sweep for legacy clients (an
// initialize, protocol 2025-11-25 and earlier): the official MCP TypeScript
// SDK client is the oracle. Each of its methods parses the server's answer
// with the SDK's own result schema and throws on a mismatch, so a feature
// conforms when the SDK's method for it answers. One feature per describe,
// each once it is on master (mcp-contract 03 checks every tool result; 35
// checks 2026-07-28 against the official schema).
//
// A server on a free port: the bundled modules, the module that declares
// everything, progress (progress-part) and completion by a template and an
// action (completion-actions), with --listPageSize 10 so the lists have pages.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const {spawn} = require('child_process');
const waitForReady = require('../helpers/wait-for-ready');
const {redisArgsFor} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'declares-everything');
// a module that reports progress (M9, M21)
const PROGRESS = path.join(ROOT, 'test', 'fixtures', 'progress-part');
// completion of a resource template, and by a module's action (M11)
const COMPLETING = path.join(ROOT, 'test', 'fixtures', 'completion-actions');
const KEY = 'sdk-feature-conformance-key';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
}

describe('mcp-contract 36: the official SDK client accepts each feature\'s answers (M18)', function() {
  this.timeout(180000);
  let tmp = null;
  let server = null;
  let client = null;
  let McpError = null;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-36-'));
    const auth = path.join(tmp, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'sdk', devices: ['*']}}), {mode: 0o600});
    const pre = path.join(ROOT, 'pre-installed-packages');
    const modules = fs.readdirSync(pre).filter((d) => fs.statSync(path.join(pre, d)).isDirectory()).flatMap((d) => ['--loadModule', path.join(pre, d)]);
    const port = await freePort();
    const args = [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(port), '--store', 'local', '--storePath', path.join(tmp, 'store'),
      '--authConfigPath', auth, '--moduleDataPath', path.join(tmp, 'module_data'), '--listPageSize', '10', ...modules, '--loadModule', FIXTURE, '--loadModule', PROGRESS, '--loadModule', COMPLETING];
    server = spawn(process.execPath, args.concat(redisArgsFor(args)), {cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], detached: true});
    server.output = '';
    server.stdout.on('data', (c) => { server.output += c.toString(); });
    await new Promise((resolve, reject) => waitForReady(server, (err) => (err ? reject(err) : resolve())));
    const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
    const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    ({McpError} = await import('@modelcontextprotocol/sdk/types.js'));
    client = new Client({name: 'countinghouse-feature-conformance', version: '0.0.0'});
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {requestInit: {headers: {'X-CH-Key': KEY}}}));
    // the module has loaded once its tool is listed
    for (let i = 0; i < 120; i++) {
      if ((await allTools()).some((t) => /notesservice_savenote$/.test(t.name))) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('the module never listed');
  });
  after(async () => {
    if (client != null) { try { await client.close(); } catch (e) { /* closing */ } }
    if (server != null && server.pid != null) { try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    if (tmp != null) fs.rmSync(tmp, {recursive: true, force: true});
  });

  async function allTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 50; page++) {
      const r = await client.listTools(cursor != null ? {cursor} : undefined);
      tools.push(...r.tools);
      if (r.nextCursor == null) return tools;
      cursor = r.nextCursor;
    }
    throw new Error('the tools list never ended');
  }
  const refused = async (p, code) => {
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert.ok(err instanceof McpError, `not an McpError: ${err && err.stack}`);
    if (code != null) assert.strictEqual(err.code, code, err.message);
  };

  describe('pagination (M1) and tool metadata (M2)', () => {
    it('listTools pages, each parsed by the SDK, to the end: every tool once', async () => {
      const tools = await allTools();
      assert.ok(tools.length > 10, `${tools.length} tools: not more than one page`);
      assert.strictEqual(new Set(tools.map((t) => t.name)).size, tools.length);
      await refused(client.listTools({cursor: 'not-a-cursor'}), -32602);
    });

    it('a tool\'s title, annotations and icons, as the SDK parses them', async () => {
      const save = (await allTools()).find((t) => /notesservice_savenote$/.test(t.name));
      assert.strictEqual(save.title, 'Save a note');
      assert.deepStrictEqual(save.annotations, {destructiveHint: true, idempotentHint: true});
      assert.ok(Array.isArray(save.icons) && /^data:image\/png;base64,/.test(save.icons[0].src), JSON.stringify(save.icons));
    });
  });

  describe('resources (M7)', () => {
    it('listResources, listResourceTemplates and readResource', async () => {
      const {resources} = await client.listResources();
      const {resourceTemplates} = await client.listResourceTemplates();
      assert.ok(resources.some((r) => /\/notes$/.test(r.uri)), JSON.stringify(resources));
      assert.ok(resourceTemplates.some((t) => /\/notes\/\{id\}$/.test(t.uriTemplate)), JSON.stringify(resourceTemplates));
      const read = await client.readResource({uri: resources.find((r) => /\/notes$/.test(r.uri)).uri});
      assert.ok(Array.isArray(read.contents) && read.contents.length > 0);
      await refused(client.readResource({uri: 'countinghouse://m/declares_everything/nowhere'}));
    });
  });

  describe('prompts and completion (M10, M11)', () => {
    it('listPrompts, getPrompt and complete', async () => {
      const {prompts} = await client.listPrompts();
      const summarise = prompts.find((p) => /summarise$/.test(p.name));
      assert.ok(summarise != null, JSON.stringify(prompts));
      const got = await client.getPrompt({name: summarise.name, arguments: {id: 'first', style: 'short'}});
      assert.match(got.messages[0].content.text, /first/);
      const done = await client.complete({ref: {type: 'ref/prompt', name: summarise.name}, argument: {name: 'style', value: ''}});
      assert.ok(Array.isArray(done.completion.values));
      await refused(client.getPrompt({name: 'no_such_prompt', arguments: {}}));
    });
  });

  // (M8's listen and M22's question held for a task are 2026-07-28's:
  // mcp-contract 35 checks them against the official schema)
  describe('completion of a resource template, and by a module\'s action (M11)', () => {
    it('complete with a ref/resource, and one a completion action answers, as the SDK parses them', async () => {
      const pages = async (list, field) => {
        const out = [];
        let cursor;
        for (let page = 0; page < 50; page++) {
          const r = await list(cursor != null ? {cursor} : undefined);
          out.push(...r[field]);
          if (r.nextCursor == null) return out;
          cursor = r.nextCursor;
        }
        throw new Error(`${field} never ended`);
      };
      const resourceTemplates = await pages((p) => client.listResourceTemplates(p), 'resourceTemplates');
      const items = resourceTemplates.find((t) => /completion_actions\/items\/\{id\}$/.test(t.uriTemplate));
      assert.ok(items != null, JSON.stringify(resourceTemplates));
      const byResource = await client.complete({ref: {type: 'ref/resource', uri: items.uriTemplate}, argument: {name: 'id', value: ''}});
      assert.ok(byResource.completion.values.includes('item-1'), JSON.stringify(byResource));
      const pick = (await pages((p) => client.listPrompts(p), 'prompts')).find((p) => /completion_actions.*pick$/.test(p.name));
      assert.ok(pick != null, 'completion-actions\' prompt is listed');
      const byAction = await client.complete({ref: {type: 'ref/prompt', name: pick.name}, argument: {name: 'colour', value: 'c'}});
      assert.ok(byAction.completion.values.includes('crimson'), JSON.stringify(byAction));
    });
  });

  describe('progress (M9)', () => {
    it('the SDK\'s onprogress receives each notifications/progress it parses, before the result', async () => {
      const work = (await allTools()).find((t) => /partservice_work$/.test(t.name));
      const seen = [];
      const result = await client.callTool({name: work.name, arguments: {}}, undefined, {onprogress: (p) => seen.push(p.progress)});
      assert.strictEqual(result.isError, false, JSON.stringify(result));
      assert.ok(seen.length > 0, 'no progress reached the SDK');
      assert.deepStrictEqual([...seen].sort((a, b) => a - b), seen, 'progress went backwards');
    });
  });

  describe('cancellation (M19)', () => {
    it('a call the SDK aborts rejects at once; the server answers the next call as before', async () => {
      const slow = (await allTools()).find((t) => /timeouttestservice_testtimeout$/.test(t.name));
      assert.ok(slow != null, 'a slow tool is bundled');
      const abort = new AbortController();
      const started = Date.now();
      const call = client.callTool({name: slow.name, arguments: {}}, undefined, {signal: abort.signal, timeout: 60000});
      setTimeout(() => abort.abort(), 300);
      let err = null;
      try { await call; } catch (e) { err = e; }
      assert.ok(err != null, 'the aborted call resolved');
      assert.ok(Date.now() - started < 5000, 'not at once');
      const save = (await allTools()).find((t) => /notesservice_savenote$/.test(t.name));
      const after = await client.callTool({name: save.name, arguments: {id: 'c36', text: 'still answering'}});
      assert.strictEqual(after.isError, false, JSON.stringify(after));
    });
  });

  describe('errors', () => {
    it('an unknown tool is an McpError the SDK parses', async () => {
      await refused(client.callTool({name: 'no_such_tool', arguments: {}}));
    });
  });
});
