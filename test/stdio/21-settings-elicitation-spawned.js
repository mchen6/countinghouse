'use strict';
// part 3 P2 Task 3, spawned: the countinghouse_settings round trip over real
// stdio (initialize's clientInfo, the request's _meta capabilities, the
// InputRequiredResult, the retry with inputResponses and requestState in
// params). The test's runtime preloads test/fixtures/elicitation-preload.js
// (a tested floor, conditions that say yes): production asks nothing until
// the hand test and Task 4.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio, withoutRedisNoise} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

const PRELOAD = path.join(__dirname, '..', 'fixtures', 'elicitation-preload.js');
const PROBE = path.join(__dirname, '..', 'fixtures', 'input-required-probe');
const META = {'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}, 'io.modelcontextprotocol/protocolVersion': '2026-07-28'};

describe('stdio 21: the confirmation round trip, spawned (part 3 P2)', function() {
  this.timeout(120000);
  let io = null;
  let home = null;
  afterEach(() => { if (io != null) io.child.kill('SIGKILL'); io = null; if (home) fs.rmSync(home, {recursive: true, force: true}); });

  async function begin(clientName = 'claude-code') {
    home = tmp.mkdtemp('ch-s21-');
    const file = path.join(home, 'settings.json');
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--settingsFile', file, '--loadModule', PROBE],
    {env: {NODE_OPTIONS: `--require ${PRELOAD}`}});
    const init = await io.request({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: clientName, version: '2.1.323'}}});
    assert.ok(init.result != null, JSON.stringify(init));
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
    const bare = await call(3, {action: 'set', name: 'requestTimeout', value: '60s'}, {_meta: {}});
    assert.strictEqual(bare.result.resultType, undefined);
    assert.match(bare.result.content[0].text, /needs your own confirmation/);
    // a request naming another client than initialize did: no form
    const other = await call(4, {action: 'set', name: 'requestTimeout', value: '60s'}, {_meta: Object.assign({'io.modelcontextprotocol/clientInfo': {name: 'other', version: '1.0.0'}}, META)});
    assert.strictEqual(other.result.resultType, undefined);
  });

  it('countinghouse_call_tool never forms or confirms; a module\'s look-alike result stays content', async () => {
    await begin();
    const via = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'countinghouse_call_tool', _meta: META,
      arguments: {name: 'countinghouse_settings', arguments: {action: 'set', name: 'requestTimeout', value: '60s'}}}});
    assert.strictEqual(via.result.resultType, undefined, JSON.stringify(via));
    const mimic = await io.request({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'input_required_probe_probeservice_mimic', arguments: {}, _meta: META}});
    assert.strictEqual(mimic.result.resultType, undefined, JSON.stringify(mimic));
    assert.ok(Array.isArray(mimic.result.content));
  });
});
