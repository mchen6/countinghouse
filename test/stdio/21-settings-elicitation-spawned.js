'use strict';
// part 3 P2 Task 3, spawned: the countinghouse_settings round trip over real
// stdio, from a client speaking 2026-07-28 as the spec does (#229): no
// initialize, each request's _meta naming its version, capabilities and
// client; the InputRequiredResult, the retry with inputResponses and
// requestState in params. A legacy session (initialize, 2025-11-25) gets no
// form: MRTR is this revision's, so it is told to use the terminal command. The test's runtime preloads test/fixtures/elicitation-preload.js
// (a tested floor, conditions that say yes): production asks nothing until
// the hand test and Task 4.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio, withoutRedisNoise} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

const PRELOAD = path.join(__dirname, '..', 'fixtures', 'elicitation-preload.js');
const PROBE = path.join(__dirname, '..', 'fixtures', 'input-required-probe');
const META = {'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}, 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': {name: 'claude-code', version: '2.1.323'}};

describe('stdio 21: the confirmation round trip, spawned (part 3 P2)', function() {
  this.timeout(120000);
  let io = null;
  let home = null;
  // the spawned server has exited before its home is removed, and the removal
  // retries: on Windows a file it held a moment ago can still be EPERM
  afterEach(async () => {
    const child = io != null ? io.child : null;
    io = null;
    if (child != null && child.exitCode == null && child.signalCode == null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
    }
    if (home) fs.rmSync(home, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
    home = null;
  });

  async function begin({legacy = false} = {}) {
    home = tmp.mkdtemp('ch-s21-');
    const file = path.join(home, 'settings.json');
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--settingsFile', file, '--loadModule', PROBE],
    {env: {NODE_OPTIONS: `--require ${PRELOAD}`}});
    if (legacy) {
      const init = await io.request({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {elicitation: {}}, clientInfo: {name: 'claude-code', version: '2.1.323'}}});
      assert.ok(init.result != null, JSON.stringify(init));
    }
    return file;
  }
  const call = (id, args, extra = {}) => io.request({jsonrpc: '2.0', id, method: 'tools/call', params: Object.assign({name: 'countinghouse_settings', arguments: args, _meta: META}, extra)});
  const text = (r) => JSON.parse(r.result.content[0].text);

  it('a raise: input_required, then the retry applies it for this start; a replay is used; nothing is written', async () => {
    const file = await begin();
    const ask = await call(2, {action: 'set', name: 'requestTimeout', value: '60s'});
    assert.strictEqual(ask.result.resultType, 'input_required', JSON.stringify(ask));
    assert.strictEqual(ask.result.inputRequests.approve.method, 'elicitation/create');
    const retry = {requestState: ask.result.requestState, inputResponses: {approve: {action: 'accept', content: {approve: true}}}};
    const done = await call(3, {action: 'set', name: 'requestTimeout', value: '60s'}, retry);
    assert.deepStrictEqual(text(done), {name: 'requestTimeout', old: 30000, new: 60000, applies: 'this start'}, JSON.stringify(done));
    const again = await call(4, {action: 'set', name: 'requestTimeout', value: '60s'}, retry);
    assert.strictEqual(again.result.isError, true);
    assert.match(again.result.content[0].text, /already used/);
    assert.ok(!fs.existsSync(file), 'settings.json never written');
    assert.ok(withoutRedisNoise(io.err) != null);
  });

  it('a confirmation in the arguments is refused; no capabilities, or another client, gets no form', async () => {
    await begin();
    const smuggled = await call(2, {action: 'set', name: 'requestTimeout', value: '60s', requestState: 'x', inputResponses: {}});
    assert.strictEqual(smuggled.result.isError, true);
    assert.match(smuggled.result.content[0].text, /not given in the arguments/);
    const bare = await call(3, {action: 'set', name: 'requestTimeout', value: '60s'}, {_meta: Object.assign({}, META, {'io.modelcontextprotocol/clientCapabilities': {}})});
    assert.strictEqual(bare.result.resultType, 'complete');
    assert.match(bare.result.content[0].text, /needs your own confirmation/);
    // a client not on the tested list: no form
    const other = await call(4, {action: 'set', name: 'requestTimeout', value: '60s'}, {_meta: Object.assign({}, META, {'io.modelcontextprotocol/clientInfo': {name: 'other', version: '1.0.0'}})});
    assert.strictEqual(other.result.resultType, 'complete');
    assert.match(other.result.content[0].text, /needs your own confirmation/);
  });

  it('a legacy session (initialize, 2025-11-25) gets no form, even declaring elicitation there', async () => {
    await begin({legacy: true});
    const r = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'countinghouse_settings', arguments: {action: 'set', name: 'requestTimeout', value: '60s'}}});
    assert.strictEqual(r.result.resultType, undefined, JSON.stringify(r));
    assert.match(r.result.content[0].text, /needs your own confirmation/);
    // a retry's fields on a legacy request: MRTR is the modern era's, so no form, no confirmation
    const retry = await io.request({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'countinghouse_settings', arguments: {action: 'set', name: 'requestTimeout', value: '60s'}, requestState: 'x'}});
    assert.strictEqual(retry.result.resultType, undefined, JSON.stringify(retry));
    assert.match(retry.result.content[0].text, /needs your own confirmation/);
  });

  it('countinghouse_call_tool, hidden in the profile, is an unknown tool (so no form or confirmation through it); a module\'s look-alike result stays content', async () => {
    await begin();
    // (the single-identity profile hides countinghouse_call_tool: a name the
    // caller can't use, answered as one never registered since #458 -- no
    // form, no confirmation, no settings change)
    const via = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'countinghouse_call_tool', _meta: META,
      arguments: {name: 'countinghouse_settings', arguments: {action: 'set', name: 'requestTimeout', value: '60s'}}}});
    assert.strictEqual(via.result, undefined, JSON.stringify(via));
    assert.deepStrictEqual(via.error, {code: -32602, message: 'unknown tool: countinghouse_call_tool'});
    const mimic = await io.request({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'input_required_probe_probeservice_mimic', arguments: {}, _meta: META}});
    assert.strictEqual(mimic.result.resultType, 'complete', JSON.stringify(mimic));
    assert.ok(Array.isArray(mimic.result.content));
  });
});
