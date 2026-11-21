'use strict';
// MCP completeness M11 (spec section 7), over real stdio: a prompt's or a
// resource template's `completion` names an action of its module, which
// completion/complete runs as that action's call (validated, rate limited,
// not billed, recorded as completion/complete) and whose values it offers,
// at most 100 of at most 256 characters. When the action fails (it throws,
// or answers no values) or takes more than 2 s, the schema's candidates are
// offered instead; and a run past 2 s is cancelled as a cancelled call is:
// what it asks afterwards is refused. A completion action is not a tool.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, MODERN_META} = require('../helpers/stdio-client');
const {testPort} = require('../helpers/test-env');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'completion-actions');
const KEY = 'stdio-test-key';
const TEMPLATE = 'countinghouse://m/completion_actions/items/{id}';

describe('stdio 33: completion actions, spawned (M11)', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  after(async () => {
    if (io != null) await io.stop();
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  it('a prompt\'s and a template\'s completion actions answer; a failing or slow one falls back to the schema\'s candidates, and a slow run is cancelled; none is a tool', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-33-'));
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}), {mode: 0o600});
    io = startStdio(['--workerThread', '--loadModule', FIXTURE, '--authConfigPath', auth, '--moduleDataPath', path.join(home, 'module_data'),
      '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`], {env: {COUNTINGHOUSE_API_KEY: KEY}});
    const late = await waitForTool(io, /pickservice_lastlate$/);
    assert.ok(late != null, withoutRedisNoise(io.err).slice(-2000));
    let id = 1;
    const ask = (method, params) => io.request({jsonrpc: '2.0', id: id++, method, params: Object.assign({_meta: MODERN_META}, params)});
    const tools = (await ask('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(!tools.some((n) => /complete(colour|id)$/.test(n)), `a completion action is listed: ${JSON.stringify(tools)}`);

    const complete = async (ref, name, value, context) => {
      const params = {ref, argument: {name, value}};
      if (context != null) params.context = {arguments: context};
      const r = await ask('completion/complete', params);
      assert.ok(r.result != null, JSON.stringify(r));
      return r.result.completion;
    };
    const PROMPT = {type: 'ref/prompt', name: 'completion_actions_pick'};
    const RESOURCE = {type: 'ref/resource', uri: TEMPLATE};

    // the prompt's action: its values, matched to the value so far
    assert.deepStrictEqual(await complete(PROMPT, 'colour', 'c'), {values: ['crimson', 'coral', 'cyan'], total: 3, hasMore: false});
    // at most 100 of its values are kept
    const many = await complete(PROMPT, 'colour', 'many');
    assert.deepStrictEqual([many.values.length, many.total, many.hasMore, many.values[0]], [100, 100, false, 'many-000']);
    // a value of at most 256 characters is kept, one longer is not (M18's
    // bounds audit: the action's own cap had no case)
    const long = await complete(PROMPT, 'colour', 'long');
    assert.deepStrictEqual(long.values.map((v) => v.length), [256], JSON.stringify(long).slice(0, 200));
    // the template's action
    assert.deepStrictEqual(await complete(RESOURCE, 'id', 'item'), {values: ['item-1', 'item-2'], total: 2, hasMore: false});
    // it throws, or answers no values: the schema's candidates
    for (const mode of ['boom', 'bad']) assert.deepStrictEqual(await complete(RESOURCE, 'id', 'i', {mode}), {values: ['i1', 'i2'], total: 2, hasMore: false}, mode);

    // past 2 s: the schema's candidates, answered at about 2 s, and the run
    // cancelled (its late request refused)
    const started = Date.now();
    assert.deepStrictEqual(await complete(RESOURCE, 'id', 'i', {mode: 'slow'}), {values: ['i1', 'i2'], total: 2, hasMore: false});
    const took = Date.now() - started;
    assert.ok(took >= 1900 && took < 2900, `answered after ${took} ms`);
    let lateGot = null;
    const end = Date.now() + 10000;
    while (lateGot == null && Date.now() < end) {
      const r = await ask('tools/call', {name: late.name, arguments: {}});
      lateGot = r.result != null && r.result.structuredContent != null ? r.result.structuredContent.late : null;
      if (lateGot == null) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(typeof(lateGot) === 'string' && lateGot !== 'answered', `the cancelled run's late request: ${JSON.stringify(lateGot)}`);

    // the actions' runs are in usage as completion/complete, never as the
    // actions' own tool names
    const report = await ask('tools/call', {name: 'countinghouse_usage_report', arguments: {}});
    const text = JSON.stringify(report.result);
    assert.match(text, /completion\/complete/, text.slice(0, 1500));
    assert.doesNotMatch(text, /pickservice_complete(colour|id)/, text.slice(0, 1500));
  });
});
