// MCP completeness M13 (the design, section 8): ctx.ask in a real worker.
// Spawned, --stdio: no port. The fixture's handler asks its one declared
// question and says in its result what came of asking
// (test/fixtures/asks-questions).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');
const {testPort} = require('../helpers/test-env');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'asks-questions');
const KEY = 'stdio-test-key';

describe('--stdio, spawned: a handler\'s ctx.ask (MCP completeness M13)', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  beforeEach(() => { home = tmp.mkdtemp('ch-ask-'); });
  afterEach(async () => {
    if (io != null) await io.stop();
    io = null;
    tmp.remove(home);
  });
  const start = (extra = []) => {
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
    io = startStdio(['--workerThread', '--loadModule', FIXTURE, '--authConfigPath', auth,
      '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`, ...extra], {env: {COUNTINGHOUSE_API_KEY: KEY}});
    return io;
  };
  const listed = async () => {
    const tool = await waitForTool(io, /probe$/);
    assert.ok(tool != null, `the module never listed; stderr without the Redis noise:\n${withoutRedisNoise(io.err)}`);
    return tool;
  };

  // a legacy call has no one to ask: the worker's ask reaches the main
  // thread, which answers ASK_UNAVAILABLE, and the handler falls back
  for (const mode of ['audit', 'enforce']) {
    it(`a legacy call's ctx.ask is answered by the main thread: no one to ask, and the handler falls back (${mode})`, async () => {
      start(['--moduleSandbox', mode]);
      const init = await io.request({...INITIALIZE, id: 1});
      assert.ok(init.result != null, JSON.stringify(init));
      const tool = await listed();
      const got = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {what: 'it'}}});
      assert.ok(got.result != null && got.result.isError !== true, JSON.stringify(got).slice(0, 600));
      const out = got.result.structuredContent;
      assert.deepStrictEqual([out.asked, out.code, out.runs], [false, 'ASK_UNAVAILABLE', 1]);
    });
  }

  // a handler running as a task has no one to ask (the design's open
  // question 5): its run's token carries no ask state
  // (--store local: its own job runner, no Redis)
  it('a task\'s ctx.ask has no one to ask, and the handler falls back', async () => {
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--loadModule', FIXTURE], {});
    const init = await io.request({...INITIALIZE, id: 1});
    assert.ok(init.result != null, JSON.stringify(init));
    const tool = await listed();
    const created = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {what: 'it'}, task: {}}});
    assert.ok(created.result != null && created.result.task != null, JSON.stringify(created).slice(0, 500));
    const taskId = created.result.task.taskId;
    let status = null;
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(status); i++) {
      status = (await io.request({jsonrpc: '2.0', id: 100 + i, method: 'tasks/get', params: {taskId}})).result.status;
      if (!['completed', 'failed'].includes(status)) await new Promise((r) => setTimeout(r, 200));
    }
    assert.strictEqual(status, 'completed');
    const got = await io.request({jsonrpc: '2.0', id: 3, method: 'tasks/result', params: {taskId}});
    assert.deepStrictEqual([got.result.structuredContent.asked, got.result.structuredContent.code], [false, 'ASK_UNAVAILABLE'], JSON.stringify(got).slice(0, 500));
  });

  // A modern request that declares form elicitation: the handler's question
  // goes to the client as an InputRequiredResult, and the client's retry
  // runs the handler again, from the top, with the answer. --store local:
  // no Redis; the used nonces and the identity secret are in the home.
  describe('a modern request that declares forms', () => {
    const META = {'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}, 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': {name: 'test', version: '1.0.0'}};
    // the fixture is a scenario (the single-identity profile lists nothing else); its tool's name is the list's
    let TOOL = null;
    const FORM = require(path.join(FIXTURE, 'schema.json')).askService.probe.questions.confirm;
    const local = (extra = []) => {
      io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
        '--moduleDataPath', path.join(home, 'module_data'), '--loadModule', FIXTURE, ...extra], {});
      return io;
    };
    const call = (id, args, extra = {}, meta = META) => io.request({jsonrpc: '2.0', id, method: 'tools/call', params: Object.assign({name: TOOL, arguments: args, _meta: meta}, extra)});
    // the module is loaded once its tool is listed; one call then, with no form declared, to see it answer
    const loaded = async () => {
      TOOL = null;
      for (let i = 0; i < 120 && TOOL == null; i++) {
        const list = await io.request({jsonrpc: '2.0', id: 8000 + i, method: 'tools/list', params: {_meta: META}});
        const tool = ((list.result && list.result.tools) || []).find((x) => /probe$/.test(x.name));
        if (tool != null) TOOL = tool.name;
        else await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(TOOL != null, `the module never listed; stderr without the Redis noise:\n${withoutRedisNoise(io.err)}`);
      const got = await call(9000, {what: 'ready'}, {}, Object.assign({}, META, {'io.modelcontextprotocol/clientCapabilities': {}}));
      assert.ok(got.result != null && got.result.structuredContent != null, JSON.stringify(got).slice(0, 500));
    };
    const codeOf = (got) => (got.result != null && got.result._meta != null ? got.result._meta['countinghouse/code'] : null);
    const accept = (state, content) => ({requestState: state, inputResponses: {answer: {action: 'accept', content}}});

    it('is answered with the question; its retry with the answer runs the handler again, which gets it; the state is used once', async () => {
      local();
      await loaded();
      const first = await call(1, {what: 'it'});
      assert.strictEqual(first.result.resultType, 'input_required', JSON.stringify(first).slice(0, 500));
      // a question, not a result: nothing of the handler's is in it
      assert.deepStrictEqual(Object.keys(first.result).filter((k) => k !== '_meta').sort(), ['inputRequests', 'requestState', 'resultType']);
      assert.deepStrictEqual(first.result.inputRequests, {answer: {method: 'elicitation/create', params: {mode: 'form', message: 'asks-questions: Do it?', requestedSchema: FORM}}});
      assert.match(first.result.requestState, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
      const retry = await call(2, {what: 'it'}, accept(first.result.requestState, {yes: true, note: 'go'}));
      assert.ok(retry.result != null && retry.result.isError !== true, JSON.stringify(retry).slice(0, 500));
      assert.deepStrictEqual([retry.result.structuredContent.asked, retry.result.structuredContent.answer], [true, {yes: true, note: 'go'}]);
      // the handler ran once for the first pass and once for the retry (and once for the readiness probe)
      assert.strictEqual(retry.result.structuredContent.runs, 3);
      // the usage records say the first pass asked, in round 1, and the retry's pass answered
      const records = [];
      const walk = (dir) => { for (const e of fs.readdirSync(dir, {withFileTypes: true})) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.jsonl')) records.push(...fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))); } };
      walk(home);
      const passes = records.filter((x) => x.tool === TOOL && x.outcome !== undefined && x.server === undefined).map((x) => [x.outcome, x.round]);
      assert.deepStrictEqual(passes.slice(-2), [['asked', 1], ['ok', undefined]], JSON.stringify(records.slice(-4)).slice(0, 600));
      const again = await call(3, {what: 'it'}, accept(first.result.requestState, {yes: true, note: 'go'}));
      assert.strictEqual(codeOf(again), 'ASK_STATE_INVALID', JSON.stringify(again).slice(0, 400));
      // and nothing ran for it
      const after = await call(4, {what: 'count'}, {}, Object.assign({}, META, {'io.modelcontextprotocol/clientCapabilities': {}}));
      assert.strictEqual(after.result.structuredContent.runs, 4);
    });

    // M13 with M9's progress: the question is the pass's answer, and nothing is sent after an answer
    // (lib/mcp/progress.js). The scenario's hops tick its progress, more than one inside the notifier's
    // interval, so one is still waiting to be sent when the handler asks.
    it('a call with a progress token that ends on a question sends no progress after it', async () => {
      // a scenario's part is found beside it, as npm installs it (lib/module-roles.js resolvePart)
      const installed = path.join(home, 'packs', 'node_modules');
      for (const name of ['asks-after-hops', 'compose-callee']) fs.cpSync(path.join(__dirname, '..', 'fixtures', name), path.join(installed, name), {recursive: true});
      io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
        '--moduleDataPath', path.join(home, 'module_data'), '--loadModule', path.join(installed, 'asks-after-hops')], {});
      let tool = null;
      for (let i = 0; i < 120 && tool == null; i++) {
        const list = await io.request({jsonrpc: '2.0', id: 8000 + i, method: 'tools/list', params: {_meta: META}});
        const found = ((list.result && list.result.tools) || []).find((x) => /probe$/.test(x.name));
        if (found != null) tool = found.name;
        else await new Promise((r) => setTimeout(r, 500));
      }
      assert.ok(tool != null, `the scenario never listed; stderr without the Redis noise:\n${withoutRedisNoise(io.err)}`);
      const progressAfter = (id) => {
        const msgs = io.lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((m) => m != null);
        const at = msgs.findIndex((m) => m.id === id);
        return {before: msgs.slice(0, at).filter((m) => m.method === 'notifications/progress' && m.params.progressToken === `p-${id}`).length,
          after: msgs.slice(at + 1).filter((m) => m.method === 'notifications/progress' && m.params.progressToken === `p-${id}`).length};
      };
      const first = await io.request({jsonrpc: '2.0', id: 31, method: 'tools/call', params: {name: tool, arguments: {hops: 6}, _meta: Object.assign({progressToken: 'p-31'}, META)}});
      assert.strictEqual(first.result.resultType, 'input_required', JSON.stringify(first).slice(0, 500));
      // longer than the notifier's interval: what was waiting would have been sent by now
      await new Promise((r) => setTimeout(r, 3 * require('../../lib/mcp/progress').MIN_INTERVAL_MS));
      const asked = progressAfter(31);
      assert.ok(asked.before >= 1, 'its hops ticked: the case has something that could be late');
      assert.strictEqual(asked.after, 0, 'nothing after the question');
      // the retry is a call of its own: its progress is its own, and ends with its answer
      const retry = await io.request({jsonrpc: '2.0', id: 32, method: 'tools/call', params: Object.assign({name: tool, arguments: {hops: 6}, _meta: Object.assign({progressToken: 'p-32'}, META)},
        accept(first.result.requestState, {yes: true}))});
      assert.deepStrictEqual([retry.result.structuredContent.asked, retry.result.structuredContent.answer, retry.result.structuredContent.sum], [true, {yes: true}, 42], JSON.stringify(retry).slice(0, 500));
      await new Promise((r) => setTimeout(r, 3 * require('../../lib/mcp/progress').MIN_INTERVAL_MS));
      assert.strictEqual(progressAfter(32).after, 0, 'nor after the result');
    });

    // M14 with M19 (the reviewer's ruling): a call cancelled while its handler works, which then asks, is
    // a cancelled call: no answer is written, and its record says cancelled. (Here the cancel drops the
    // call's token, so the handler's ask fails before any form; a cancel that lands while the form is
    // being made is questions 05's case.)
    it('a call cancelled before its handler asks: no answer, no state made, and its record says cancelled, not asked', async () => {
      local();
      await loaded();
      io.notify({jsonrpc: '2.0', id: 41, method: 'tools/call', params: {name: TOOL, arguments: {what: 'late', wait: 1500}, _meta: META}});
      await new Promise((r) => setTimeout(r, 400));
      io.notify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 41}});
      await new Promise((r) => setTimeout(r, 3000));
      assert.deepStrictEqual(io.lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter((m) => m != null && m.id === 41), [], 'no answer');
      const records = [];
      const walk = (dir) => { for (const e of fs.readdirSync(dir, {withFileTypes: true})) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.jsonl')) records.push(...fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))); } };
      walk(home);
      const outs = records.filter((x) => x.tool === TOOL && x.outcome !== undefined && x.server === undefined);
      assert.deepStrictEqual(outs.slice(-1).map((x) => [x.outcome, x.round]), [['cancelled', undefined]], JSON.stringify(outs.slice(-3)).slice(0, 600));
    });

    it('a decline is null to the handler; an answer that does not fit the form gets the question again; a state is for its own arguments', async () => {
      local();
      await loaded();
      const first = await call(1, {what: 'it'});
      const declined = await call(2, {what: 'it'}, {requestState: first.result.requestState, inputResponses: {answer: {action: 'decline'}}});
      assert.ok(declined.result != null && declined.result.structuredContent != null, JSON.stringify(declined).slice(0, 700));
      assert.deepStrictEqual([declined.result.structuredContent.asked, declined.result.structuredContent.answer], [true, null]);
      const second = await call(3, {what: 'that'});
      assert.strictEqual(second.result.inputRequests.answer.params.message, 'asks-questions: Do that?');
      const wrong = await call(4, {what: 'that'}, accept(second.result.requestState, {yes: 'maybe'}));
      assert.strictEqual(wrong.result.resultType, 'input_required', JSON.stringify(wrong).slice(0, 400));
      assert.notStrictEqual(wrong.result.requestState, second.result.requestState);
      // the new state, with other arguments: refused, whatever it answers
      const other = await call(5, {what: 'another'}, accept(wrong.result.requestState, {yes: true}));
      assert.strictEqual(codeOf(other), 'ASK_STATE_INVALID');
      // and in the arguments it is no answer at all
      const smuggled = await call(6, {what: 'that', requestState: wrong.result.requestState, inputResponses: {answer: {action: 'accept', content: {yes: true}}}});
      assert.strictEqual(smuggled.result.isError, true, JSON.stringify(smuggled).slice(0, 400));
    });

    it('with no form declared, or module questions turned off, there is no one to ask and the handler falls back', async () => {
      local();
      await loaded();
      const bare = await call(1, {what: 'it'}, {}, Object.assign({}, META, {'io.modelcontextprotocol/clientCapabilities': {}}));
      assert.deepStrictEqual([bare.result.structuredContent.asked, bare.result.structuredContent.code], [false, 'ASK_UNAVAILABLE']);
      await io.stop();
      local(['--moduleQuestions', 'off']);
      await loaded();
      const off = await call(2, {what: 'it'});
      assert.ok(off.result != null && off.result.structuredContent != null, JSON.stringify(off).slice(0, 700));
      assert.deepStrictEqual([off.result.structuredContent.asked, off.result.structuredContent.code], [false, 'ASK_UNAVAILABLE']);
    });

    // Under --stdio a restart is a new session: its id is made at each start
    // (lib/sessions.js), and a state is bound to its session. So a state
    // from before a restart is good for nothing after it, used or not.
    // Where a session keeps its id across a restart (a shared runtime's,
    // resumed; HTTP, which has none) the used nonces kept in the store are
    // what refuse a replay: test/session-runtime and test/questions.
    it('a --stdio restart is a new session: a state from before it is refused after it, used or not, and the call asks anew', async () => {
      local();
      await loaded();
      const used = await call(1, {what: 'it'});
      const unused = await call(2, {what: 'that'});
      const done = await call(3, {what: 'it'}, accept(used.result.requestState, {yes: true}));
      assert.ok(done.result != null && done.result.structuredContent != null, JSON.stringify(done).slice(0, 700));
      assert.strictEqual(done.result.structuredContent.asked, true);
      await io.stop();
      local();
      await loaded();
      assert.strictEqual(codeOf(await call(4, {what: 'it'}, accept(used.result.requestState, {yes: true}))), 'ASK_STATE_INVALID');
      assert.strictEqual(codeOf(await call(5, {what: 'that'}, accept(unused.result.requestState, {yes: false}))), 'ASK_STATE_INVALID');
      // the same text to the caller for both, and the runtime's own line says why, for the operator alone
      assert.ok(io.err.split('\n').filter((l) => /a retry's answer was refused \(ASK_STATE_INVALID: mac\)/.test(l)).length === 2, 'the log says why');
      const anew = await call(6, {what: 'that'});
      assert.strictEqual(anew.result.resultType, 'input_required');
      const answered = await call(7, {what: 'that'}, accept(anew.result.requestState, {yes: false}));
      assert.deepStrictEqual([answered.result.structuredContent.asked, answered.result.structuredContent.answer], [true, {yes: false}]);
    });
  });
});
