// MCP completeness M13 (ctx.ask; the design, section 8), over HTTP, across a
// restart. A modern HTTP request has no session, so a question's state from
// before a restart still verifies after it: its key is derived from the
// identity secret, which is on disk, and its binding (the caller, no
// session, the tool, the arguments) is unchanged. What refuses a used one is
// its nonce and nothing else, kept in the store (--store local: a file).
// One not yet used is still good. The reviewer's condition on M12.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');

const PORT = testPort(9654);
const KEY = 'ask-restart-key';
const ASKS = path.join(ROOT, 'test', 'fixtures', 'asks-questions');
const FORMS = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {elicitation: {}},
  'io.modelcontextprotocol/clientInfo': {name: 'test', version: '1.0.0'}};

describe('sandbox 61: a module\'s question over HTTP: across a restart, and in single-thread mode (MCP completeness M13)', function() {
  this.timeout(180000);
  let base = null;
  let server = null;
  let nextId = 1;
  const start = async (thread = ['--workerThread']) => {
    server = await startServer(PORT, [...thread, '--debug', '--debugKey', KEY, '--store', 'local', '--storePath', path.join(base, 'store'),
      '--moduleDataPath', path.join(base, 'module_data'), '--loadModule', ASKS]);
  };
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ask-http-')); });
  afterEach(() => {
    stopServer(server);
    server = null;
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });
  // one modern MCP request, answered as JSON
  const mcp = (method, params) => new Promise((resolve, reject) => {
    // the headers a 2026-07-28 request carries, each matching its body: the version, the method, and a tool's name
    const req = request(`http://127.0.0.1:${PORT}`).post('/mcp').set('X-CH-Key', KEY).set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', '2026-07-28').set('Mcp-Method', method);
    if (params != null && typeof(params.name) === 'string') req.set('Mcp-Name', params.name);
    req.send({jsonrpc: '2.0', id: nextId++, method, params: Object.assign({_meta: FORMS}, params)})
      .end((err, res) => (err ? reject(err) : resolve(res.body)));
  });
  let tool = null;
  const listed = async () => {
    tool = null;
    let list = null;
    for (let i = 0; i < 120 && tool == null; i++) {
      list = await mcp('tools/list', {});
      tool = list != null && list.result != null ? ((list.result.tools.find((x) => /probe$/.test(x.name)) || {}).name || null) : null;
      if (tool == null) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(tool != null, `the module never listed; the last list: ${JSON.stringify(list).slice(0, 600)}\n${server.output.slice(-1500)}`);
  };
  const call = (args, extra = {}) => mcp('tools/call', Object.assign({name: tool, arguments: args}, extra));
  const accept = (state, content) => ({requestState: state, inputResponses: {answer: {action: 'accept', content}}});
  const codeOf = (got) => (got != null && got.result != null && got.result._meta != null ? got.result._meta['countinghouse/code'] : null);

  it('a state used before the restart is refused after it, as used; one not yet used is still good', async () => {
    await start();
    await listed();
    const used = await call({what: 'it'});
    const unused = await call({what: 'that'});
    assert.deepStrictEqual([used.result && used.result.resultType, unused.result && unused.result.resultType], ['input_required', 'input_required'], JSON.stringify(used).slice(0, 500));
    const done = await call({what: 'it'}, accept(used.result.requestState, {yes: true}));
    assert.ok(done.result != null && done.result.structuredContent != null && done.result.structuredContent.asked === true, JSON.stringify(done).slice(0, 500));
    assert.ok(fs.existsSync(path.join(base, 'store', 'used-nonces.json')), 'the used nonce is in the store');

    stopServer(server);
    await new Promise((r) => setTimeout(r, 1500));
    await start();
    await listed();
    const replay = await call({what: 'it'}, accept(used.result.requestState, {yes: true}));
    assert.strictEqual(codeOf(replay), 'ASK_STATE_INVALID', JSON.stringify(replay).slice(0, 500));
    // as used, and for no other reason (the runtime's own line; the caller is told one text whatever failed)
    assert.ok(/a retry's answer was refused \(ASK_STATE_INVALID: used\)/.test(server.output), server.output.split('\n').filter((l) => /refused/.test(l)).join('\n').slice(0, 600));
    const kept = await call({what: 'that'}, accept(unused.result.requestState, {yes: false}));
    assert.ok(kept.result != null && kept.result.structuredContent != null, JSON.stringify(kept).slice(0, 500));
    assert.deepStrictEqual([kept.result.structuredContent.asked, kept.result.structuredContent.answer], [true, {yes: false}]);
    assert.strictEqual(codeOf(await call({what: 'that'}, accept(unused.result.requestState, {yes: false}))), 'ASK_STATE_INVALID');
  });

  // Single-thread mode (--workerThread false) has no worker and no call
  // token: the call's ask context rides on its args, the form is read from
  // the device's own schema document, and the answer is checked on the main
  // thread, which in this mode isolates nothing.
  it('single-thread mode: the handler\'s question is the call\'s answer, and the retry\'s answer reaches the handler', async () => {
    await start(['--workerThread', 'false']);
    await listed();
    const first = await call({what: 'it'});
    assert.strictEqual(first.result && first.result.resultType, 'input_required', JSON.stringify(first).slice(0, 600));
    assert.deepStrictEqual(first.result.inputRequests.answer.params, {mode: 'form', message: 'asks-questions: Do it?',
      requestedSchema: require(path.join(ASKS, 'schema.json')).askService.probe.questions.confirm});
    const wrong = await call({what: 'it'}, accept(first.result.requestState, {yes: 'perhaps'}));
    assert.strictEqual(wrong.result && wrong.result.resultType, 'input_required', 'an answer that does not fit the form gets the question again');
    const extra = await call({what: 'it'}, accept(wrong.result.requestState, {yes: true, more: 1}));
    assert.strictEqual(extra.result && extra.result.resultType, 'input_required', 'so does one with a property the form has not');
    const done = await call({what: 'it'}, accept(extra.result.requestState, {yes: true}));
    assert.ok(done.result != null && done.result.structuredContent != null, JSON.stringify(done).slice(0, 600));
    assert.deepStrictEqual([done.result.structuredContent.asked, done.result.structuredContent.answer], [true, {yes: true}]);
    assert.strictEqual(codeOf(await call({what: 'it'}, accept(extra.result.requestState, {yes: true}))), 'ASK_STATE_INVALID');
    // and a request that declares no form has no one to ask
    const bare = await mcp('tools/call', {name: tool, arguments: {what: 'it'}, _meta: Object.assign({}, FORMS, {'io.modelcontextprotocol/clientCapabilities': {}})});
    assert.deepStrictEqual([bare.result.structuredContent.asked, bare.result.structuredContent.code], [false, 'ASK_UNAVAILABLE']);
  });
});
