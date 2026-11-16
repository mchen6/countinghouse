// MCP completeness M14 (the design, section 8, "Over composition"): a part's
// ctx.ask reaches the outer call's user, over HTTP, by both ways a hop is
// made: routed through the main thread, and over a direct peer channel.
//
// The scenario (test/fixtures/asks-through-part) declares no question of its
// own and calls its part (asks-part), which asks before it acts. The part is
// unlisted: the dialog carries the scenario's name, never the part's.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const callAddress = require('../../lib/call-address');

const PORT = testPort(9637);
const KEY = 'ask-composition-key';
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const PART_FORM = require(path.join(FIXTURES, 'asks-part', 'schema.json')).partService.store.questions.overwrite;
const FORMS = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {elicitation: {}},
  'io.modelcontextprotocol/clientInfo': {name: 'test', version: '1.0.0'}};
const NO_FORMS = Object.assign({}, FORMS, {'io.modelcontextprotocol/clientCapabilities': {}});

describe('sandbox 62: a part\'s question reaches the outer call\'s user, over HTTP (MCP completeness M14)', function() {
  this.timeout(180000);
  let base = null;
  let server = null;
  let nextId = 1;
  let tool = null;
  // a scenario's part is found beside it, as npm installs it (lib/module-roles.js resolvePart)
  const start = async (extra = []) => {
    const installed = path.join(base, 'packs', 'node_modules');
    for (const name of ['asks-through-part', 'asks-part']) fs.cpSync(path.join(FIXTURES, name), path.join(installed, name), {recursive: true});
    server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', KEY, '--store', 'local', '--storePath', path.join(base, 'store'),
      '--moduleDataPath', path.join(base, 'module_data'), '--loadModule', path.join(installed, 'asks-through-part'), ...extra]);
    tool = null;
    let list = null;
    for (let i = 0; i < 120 && tool == null; i++) {
      list = await mcp('tools/list', {});
      tool = list != null && list.result != null ? ((list.result.tools.find((x) => /run$/.test(x.name)) || {}).name || null) : null;
      if (tool == null) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(tool != null, `the scenario never listed; the last list: ${JSON.stringify(list).slice(0, 600)}\n${server.output.slice(-1500)}`);
    assert.ok(!list.result.tools.some((x) => /store$/.test(x.name)), 'the part is not listed');
  };
  beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ask-comp-')); });
  afterEach(() => {
    stopServer(server);
    server = null;
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });
  // one modern MCP request, answered as JSON
  const mcp = (method, params, meta = FORMS) => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${PORT}`).post('/mcp').set('X-CH-Key', KEY).set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', '2026-07-28').set('Mcp-Method', method);
    if (params != null && typeof(params.name) === 'string') req.set('Mcp-Name', params.name);
    req.send({jsonrpc: '2.0', id: nextId++, method, params: Object.assign({_meta: meta}, params)})
      .end((err, res) => (err ? reject(err) : resolve(res.body)));
  });
  const call = (args, extra = {}, meta = FORMS) => mcp('tools/call', Object.assign({name: tool, arguments: args}, extra), meta);
  const accept = (state, content) => ({requestState: state, inputResponses: {answer: {action: 'accept', content}}});

  // (direct peer channels are on unless turned off: a routed hop is every hop only with them off. Each way
  // has its own place where the main thread issues the hop's token, and each was seen to fail these cases
  // with its own change taken out.)
  for (const [how, flags] of [['a routed hop', ['--directPeerChannels', 'false']], ['a direct peer channel', ['--directPeerChannels', 'true']]]) {
    describe(`by ${how}`, () => {
      it('the part\'s question is the call\'s answer, under the scenario\'s name; the retry runs both again and the part gets the answer', async () => {
        await start(flags);
        const first = await call({id: 'a.txt'});
        assert.strictEqual(first.result && first.result.resultType, 'input_required', `${JSON.stringify(first).slice(0, 500)}\n${server.output.slice(-1200)}`);
        // the part's declared sentence and form, under the listed module's name: the part is never named
        assert.deepStrictEqual(first.result.inputRequests, {answer: {method: 'elicitation/create', params: {mode: 'form', message: 'asks-through-part: Replace a.txt?', requestedSchema: PART_FORM}}});
        assert.ok(!JSON.stringify(first).includes('asks-part'), 'an unlisted part is not named to the client');
        const retry = await call({id: 'a.txt'}, accept(first.result.requestState, {replace: true}));
        assert.deepStrictEqual(retry.result && retry.result.structuredContent, {part: {asked: true, answer: {replace: true}}}, JSON.stringify(retry).slice(0, 500));
        // the answer was for that text: the same call about another thing is asked anew, and a used state is refused
        const other = await call({id: 'b.txt'});
        assert.strictEqual(other.result.inputRequests.answer.params.message, 'asks-through-part: Replace b.txt?');
        const replay = await call({id: 'a.txt'}, accept(first.result.requestState, {replace: true}));
        assert.strictEqual(replay.result._meta['countinghouse/code'], 'ASK_STATE_INVALID', JSON.stringify(replay).slice(0, 400));
      });

      it('an answer that does not fit the part\'s form gets the part\'s question again; a decline is null to the part', async () => {
        await start(flags);
        const first = await call({id: 'a.txt'});
        const wrong = await call({id: 'a.txt'}, accept(first.result.requestState, {replace: 'yes'}));
        assert.strictEqual(wrong.result && wrong.result.resultType, 'input_required', JSON.stringify(wrong).slice(0, 400));
        const declined = await call({id: 'a.txt'}, {requestState: wrong.result.requestState, inputResponses: {answer: {action: 'decline'}}});
        assert.deepStrictEqual(declined.result.structuredContent, {part: {asked: true, answer: null}}, JSON.stringify(declined).slice(0, 400));
      });

      it('an outer handler that catches the pending question and returns a result: the result stands, and the question is dropped', async () => {
        await start(flags);
        const got = await call({id: 'a.txt', mode: 'catch'});
        assert.deepStrictEqual(got.result && got.result.structuredContent, {caught: 'ASK_PENDING'}, JSON.stringify(got).slice(0, 500));
        assert.strictEqual(got.result.resultType, 'complete');
      });

      it('with no one to ask the outer call (no form declared), the part has no one either, and falls back', async () => {
        await start(flags);
        const got = await call({id: 'a.txt'}, {}, NO_FORMS);
        assert.deepStrictEqual(got.result && got.result.structuredContent, {part: {asked: false, code: 'ASK_UNAVAILABLE'}}, JSON.stringify(got).slice(0, 500));
      });
    });
  }

  // The scenario declares no question, and can still end on one: its part's. So it takes no answer from
  // its arguments either (the reviewer's ruling: the precise walk over the verified declared calls).
  it('a scenario whose part asks takes no answer from its arguments, though its own action declares no question', async () => {
    await start();
    for (const smuggled of [{requestState: 'v1.x.y'}, {inputResponses: {answer: {action: 'accept', content: {replace: true}}}}]) {
      const got = await call(Object.assign({id: 'a.txt'}, smuggled));
      assert.strictEqual(got.result && got.result._meta && got.result._meta['countinghouse/code'], 'ARGUMENTS_INVALID', JSON.stringify(got).slice(0, 400));
    }
  });

  // the reviewer's addition: an outer call that came by HTTP invoke-action has no one to ask, and so has its part
  it('under an outer call made by HTTP invoke-action, a part has no one to ask', async () => {
    await start();
    const id = callAddress.deviceIDForName('asks-through-part');
    const got = await post(PORT, KEY, `/devices/${id}/invoke-action`, {serviceID: 'urn:countinghouse-test:serviceID:packService', actionName: 'run', input: {id: 'a.txt'}});
    assert.strictEqual(got.status, 200, JSON.stringify(got.body).slice(0, 400));
    assert.deepStrictEqual(got.body.output, {part: {asked: false, code: 'ASK_UNAVAILABLE'}}, JSON.stringify(got.body).slice(0, 400));
  });
});
