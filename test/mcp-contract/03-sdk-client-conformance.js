// Every tool result conforms to what tools/list advertises, as the official
// MCP TypeScript SDK client checks it.
//
// Client.callTool validates a result's structuredContent against the tool's
// advertised outputSchema and throws -32602 when they disagree. Before the
// 8.0.0 result change, every module tool failed that check: handlers return
// {output: <result>}, the gateway passed the whole object through, and
// tools/list advertised the schema of <result> alone. This drives the real
// client against every bundled module, both composite examples and a fixture
// with one action per result shape the MCP layer has to handle, and checks
// each result with ajv as well, so a failure names the field.
//
// The server runs without --authoringTools on purpose: the load/validate
// authoring tools change server state, and nothing here should call them.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const net    = require('net');
const spawn  = require('child_process').spawn;
const request = require('supertest');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const waitForReady = require('../helpers/wait-for-ready');

const ROOT    = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'mcp-conformance-module');
const KEY     = 'mcp-conformance-test-key';
const SHAPE   = 'mcp_conformance_shapeservice_';

// One entry per tool tools/list returns -- the two tests below fail on a
// listed tool with no entry and on an entry for a tool that is not listed.
// `expect: 'skip'` is only for the two echo timeout actions, whose handlers
// sleep 40 s; the error path they would exercise is covered by the
// errorinfotestservice actions.
function argsTable(scanDir) {
  const line = '2026-09-01T00:00:00.000Z WARN disk usage at 91% on /var/data';
  return {
    countinghouse_check_balance:                                {args: {}, expect: 'ok'},
    countinghouse_usage_report:                                 {args: {groupBy: 'tool'}, expect: 'ok'},
    composite_demo_compositeservice_run:                        {args: {text: 'hi'}, expect: 'ok'},
    echo_device_client_x_api:                                   {args: {}, expect: 'ok'},
    echo_device_client_errtestservice_testerrorinfo:            {args: {foo: 'x'}, expect: 'error'},
    echo_device_echoservice_echo:                               {args: {foo: [], bar: 'b'}, expect: 'ok'},
    echo_device_echoservice_echoasync:                          {args: {foo: [], bar: 'b'}, expect: 'ok'},
    echo_device_timeouttestservice_testtimeout:                 {args: {}, expect: 'skip'},
    echo_device_timeouttestservice_testtimeoutasync:            {args: {}, expect: 'skip'},
    echo_device_errorinfotestservice_testerrorinfo:             {args: {foo: 'x'}, expect: 'error'},
    echo_device_errorinfotestservice_testfunctionreturnerror:   {args: {}, expect: 'error'},
    echo_device_errorinfotestservice_testnullreturnerror:       {args: {}, expect: 'error'},
    echo_device_errorinfotestservice_testnumbertypereturnerror: {args: {}, expect: 'error'},
    echo_device_errorinfotestservice_teststringtypereturnerror: {args: {}, expect: 'error'},
    echo_device_errorinfotestservice_testbooleantypereturnerror: {args: {}, expect: 'error'},
    echo_device_errorinfotestservice_testerrorinfoasync:        {args: {foo: 'x'}, expect: 'error'},
    echo_device_errorinfotestservice_testthrowerror:            {args: {foo: 'x'}, expect: 'error'},
    echo_device_errorinfotestservice_testthrowerrorasync:       {args: {foo: 'x'}, expect: 'error'},
    echo_device_errorinfotestservice_testasyncthrowindomain:    {args: {foo: 'x'}, expect: 'error'},
    echo_device_errorinfotestservice_testasyncthrowinasync:     {args: {foo: 'x'}, expect: 'error'},
    perf_callee_demo_perfcalleeservice_echopayload:             {args: {data: 'x'}, expect: 'ok'},
    perf_caller_demo_perfcallerservice_run:                     {args: {payloadSizeBytes: 16}, expect: 'ok'},
    transform_demo_transformservice_uppercase:                  {args: {text: 'a'}, expect: 'ok'},
    log_read_readservice_list:                                  {args: {dir: '/data/sample-logs'}, expect: 'ok'},
    log_read_readservice_read:                                  {args: {dir: '/data/sample-logs', name: 'app-01.log'}, expect: 'ok'},
    pii_redact_redactservice_redact:                            {args: {lines: [line]}, expect: 'ok'},
    error_cluster_clusterservice_cluster:                       {args: {lines: [line]}, expect: 'ok'},
    log_triage_triageservice_triage:                            {args: {dir: '/data/sample-logs', maxFiles: 1}, expect: 'ok'},
    dep_audit_auditservice_audit:                               {args: {manifest: '{"name":"x","dependencies":{"a":"^1.0.0"}}'}, expect: 'ok'},
    repo_scan_scanservice_scan:                                 {args: {path: scanDir}, expect: 'ok'},
    secret_detect_detectservice_detect:                         {args: {files: [{path: 'a.txt', content: 'nothing here'}]}, expect: 'ok'},
    repo_review_reviewservice_review:                           {args: {path: scanDir}, expect: 'ok'},
    [`${SHAPE}object_out`]:                                     {args: {}, expect: 'ok'},
    [`${SHAPE}no_schema_string`]:                               {args: {}, expect: 'ok'},
    [`${SHAPE}no_schema_object`]:                               {args: {}, expect: 'ok'},
    [`${SHAPE}no_schema_empty`]:                                {args: {}, expect: 'ok'},
    [`${SHAPE}prefix_items_out`]:                               {args: {}, expect: 'ok'},
    [`${SHAPE}coded_error`]:                                    {args: {}, expect: 'error'},
    [`${SHAPE}strict_out`]:                                     {args: {}, expect: 'error'}
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
}

// The test key may use every device. The composites also need their internal
// identities: the bundled demos' documented grants (see test/auth/12), and the
// examples' own, read from their auth.json files so a change there (key
// strings, say) follows automatically.
const BUNDLED_IDENTITIES = ['composite-demo-internal', 'aabbcc', 'perf-caller-demo-internal'];

function writeAuth(dir) {
  const auth = {[KEY]: {userName: 'mcp-conformance', devices: ['*']}};
  // each bound to its demo (R2-1 Task 4: the demos declare their calls)
  const RUNS = {'composite-demo-internal': 'composite-demo', 'aabbcc': 'echo-device-client', 'perf-caller-demo-internal': 'perf-caller-demo'};
  BUNDLED_IDENTITIES.forEach((k, i) => { auth[k] = {userName: `bundled-demo-identity-${i + 1}`, devices: ['*'], runsModules: [RUNS[k]]}; });
  for (const f of ['examples/log-triage/auth.json', 'examples/repo-review/auth.json']) {
    const entries = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const [k, v] of Object.entries(entries)) if (Array.isArray(v.runsModules)) auth[k] = v;
  }
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify(auth));
  return file;
}

function moduleArgs() {
  const out = [];
  const pre = path.join(ROOT, 'pre-installed-packages');
  for (const d of fs.readdirSync(pre)) if (fs.statSync(path.join(pre, d)).isDirectory()) out.push('--loadModule', path.join(pre, d));
  for (const ex of ['log-triage', 'repo-review']) {
    const base = path.join(ROOT, 'examples', ex);
    for (const d of fs.readdirSync(base)) {
      if (fs.existsSync(path.join(base, d, 'api.json'))) out.push('--loadModule', path.join(base, d));
    }
  }
  return out.concat('--loadModule', FIXTURE);
}

function startServer(port, tmp, done) {
  const dataDir = path.join(tmp, 'module_data');
  const gen = spawn(process.execPath, [path.join(ROOT, 'examples', 'log-triage', 'generate-logs.js'),
    '--dir', path.join(dataDir, 'log-read', 'data', 'sample-logs'), '--files', '2', '--lines', '20'], {stdio: 'ignore'});
  gen.on('exit', () => {
    const args = [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(port),
      '--authProvider', 'file', '--authConfigPath', writeAuth(tmp), '--moduleDataPath', dataDir].concat(moduleArgs());
    const server = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], detached: true});
    server.output = '';
    server.stdout.on('data', (c) => { server.output += c.toString(); });
    waitForReady(server, (err) => done(err, server));
  });
}

function rpc(port, method, params) {
  return request(`http://127.0.0.1:${port}`).post('/mcp')
    .set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream').set('X-CH-Key', KEY)
    .send({jsonrpc: '2.0', id: 1, method, params}).then((res) => res.body);
}

describe('mcp-contract 03: the official SDK client accepts every tool result', function() {
  this.timeout(180000);

  const ajv = addFormats(new Ajv2020({strict: false, allErrors: true}));
  let tmp, port, server, client, sdkTypes, tools, ARGS;

  before((done) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-conformance-'));
    // repo-scan and repo-review read a directory; the fixture is small, and
    // outside /tmp, which a sandboxed module sees as its own private one.
    ARGS = argsTable(FIXTURE);
    freePort().then((p) => {
      port = p;
      startServer(port, tmp, async (err, s) => {
        server = s;
        if (err) return done(err);
        try {
          const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
          const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
          sdkTypes = await import('@modelcontextprotocol/sdk/types.js');
          client = new Client({name: 'countinghouse-conformance-test', version: '0.0.0'});
          await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
            {requestInit: {headers: {'X-CH-Key': KEY}}}));
          tools = (await client.listTools()).tools;
          return done();
        } catch (e) { return done(e); }
      });
    }, done);
  });

  after(async () => {
    if (client != null) { try { await client.close(); } catch (e) { /* closing */ } }
    if (server != null && server.pid != null) { try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
    if (tmp != null) fs.rmSync(tmp, {recursive: true, force: true});
  });

  const byName = (n) => tools.find((t) => t.name === n);

  it('every listed tool has an ARGS entry', () => {
    assert.deepStrictEqual(tools.map((t) => t.name).filter((n) => !(n in ARGS)), []);
  });

  it('ARGS has no stale entries', () => {
    const listed = tools.map((t) => t.name);
    assert.deepStrictEqual(Object.keys(ARGS).filter((n) => !listed.includes(n)), []);
  });

  it('every listed tool conforms as the SDK client sees it', async () => {
    const failures = [];
    for (const tool of tools) {
      const entry = ARGS[tool.name];
      if (entry == null || entry.expect === 'skip') continue;
      let r;
      try {
        r = await client.callTool({name: tool.name, arguments: entry.args});
      } catch (e) {
        failures.push(`${tool.name}: SDK threw ${e.code} ${e.message}`);
        continue;
      }
      if (entry.expect === 'error') {
        if (r.isError !== true) failures.push(`${tool.name}: expected an error result`);
        if (r.structuredContent !== undefined) failures.push(`${tool.name}: an error result carries structuredContent`);
        continue;
      }
      if (r.isError === true) { failures.push(`${tool.name}: unexpected error ${JSON.stringify(r.content)}`); continue; }
      if (tool.outputSchema != null) {
        if (r.structuredContent === undefined) { failures.push(`${tool.name}: no structuredContent`); continue; }
        const validate = ajv.compile(tool.outputSchema);
        if (!validate(r.structuredContent)) failures.push(`${tool.name}: ${ajv.errorsText(validate.errors)}`);
      } else {
        if (r.structuredContent !== undefined) failures.push(`${tool.name}: structuredContent without an advertised outputSchema`);
        if (!Array.isArray(r.content) || r.content[0] == null || r.content[0].type !== 'text') failures.push(`${tool.name}: no text content`);
      }
    }
    assert.deepStrictEqual(failures, []);
  });

  it('an object result is the module output itself, in both structuredContent and the text', async () => {
    const r = await client.callTool({name: `${SHAPE}object_out`, arguments: {}});
    assert.deepStrictEqual(r.structuredContent, {text: 'ok'});
    assert.deepStrictEqual(JSON.parse(r.content[0].text), {text: 'ok'});
  });

  it('a tool without an output schema is listed without one and returns text only', async () => {
    assert.strictEqual(byName(`${SHAPE}no_schema_string`).outputSchema, undefined);
    const s = await client.callTool({name: `${SHAPE}no_schema_string`, arguments: {}});
    assert.strictEqual(s.content[0].text, 'plain text');
    const o = await client.callTool({name: `${SHAPE}no_schema_object`, arguments: {}});
    assert.strictEqual(o.structuredContent, undefined);
    assert.deepStrictEqual(JSON.parse(o.content[0].text), {a: 1});
    const e = await client.callTool({name: `${SHAPE}no_schema_empty`, arguments: {}});
    assert.deepStrictEqual(e.content, [{type: 'text', text: ''}]);
  });

  it('a 2020-12 prefixItems output schema is accepted by the SDK', async () => {
    const r = await client.callTool({name: `${SHAPE}prefix_items_out`, arguments: {}});
    assert.deepStrictEqual(r.structuredContent, {pair: ['a', 1]});
  });

  // The SDK validates structuredContent on error results too, so an error's
  // code rides in _meta, never in structuredContent -- coded_error's strict
  // schema would reject a {code} object.
  it('an error result on a tool with a strict outputSchema carries its code in _meta and is accepted', async () => {
    assert.notStrictEqual(byName(`${SHAPE}coded_error`).outputSchema, undefined);
    const r = await client.callTool({name: `${SHAPE}coded_error`, arguments: {}});
    assert.strictEqual(r.isError, true);
    assert.strictEqual(r.structuredContent, undefined);
    assert.strictEqual(r._meta['countinghouse/code'], 'CONFORMANCE_CODED');
  });

  describe('tasks/result', () => {
    async function runTask(name) {
      const created = await rpc(port, 'tools/call', {name, arguments: {}, task: {}});
      const taskId = created.result.task.taskId;
      for (let i = 0; i < 100; i++) {
        const got = await rpc(port, 'tasks/get', {taskId});
        if (got.result && got.result.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const res = await rpc(port, 'tasks/result', {taskId});
      return sdkTypes.CallToolResultSchema.parse(res.result);
    }

    it('a task with an output schema returns the module output as structuredContent', async () => {
      const r = await runTask(`${SHAPE}object_out`);
      assert.deepStrictEqual(r.structuredContent, {text: 'ok'});
      const validate = ajv.compile(byName(`${SHAPE}object_out`).outputSchema);
      assert.ok(validate(r.structuredContent), ajv.errorsText(validate.errors));
    });

    it('a task without an output schema returns text only', async () => {
      const r = await runTask(`${SHAPE}no_schema_string`);
      assert.strictEqual(r.structuredContent, undefined);
      assert.strictEqual(r.content[0].text, 'plain text');
    });
  });
});
