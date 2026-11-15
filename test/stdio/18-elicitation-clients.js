'use strict';
// lib/elicitation-clients.js (part 3 P2, Task 1): only a client on the
// tested-client list, at or above the version its hand test passed, that
// declares form elicitation on the request itself, may be asked to confirm a
// loosening in a dialog. Until a hand test sets a floor, no client may.
const assert = require('assert');
const clients = require('../../lib/elicitation-clients');

describe('stdio 18: the tested-client allowlist for elicitation (part 3 P2)', () => {
  const fs = require('fs');
  const path = require('path');
  const FORM = {elicitation: {}};
  // the shipped list is frozen: a test's own copy, with the ranges it sets
  let list = clients.ALLOWLIST;
  const may = (clientInfo, capabilities = FORM) => clients.clientMayElicit({clientInfo, capabilities}, list);
  const name = clients.CLAUDE_CODE;
  beforeEach(() => { list = clients.ALLOWLIST; });
  // tested: [[from, before], ...], each exclusive of `before`
  const withTested = (...ranges) => { list = clients.listFrom({clients: [{name, conditions: 'claude-code', tested: ranges.map(([from, before]) => ({from, before}))}]}); };

  it('the data is one JSON file (the automated re-test edits it); it ships with no tested range: no client is asked', () => {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'elicitation-clients.json'), 'utf8'));
    assert.deepStrictEqual(data.clients.map((c) => [c.name, c.conditions, c.tested]), [['claude-code', 'claude-code', []]]);
    assert.deepStrictEqual(may({name, version: '9.9.9'}), {ok: false, why: 'not tested yet'});
  });

  it('a version inside a tested range, declaring form elicitation, may; numeric comparison', () => {
    withTested(['2.1.323', '2.1.324']);
    assert.deepStrictEqual(may({name, version: '2.1.323'}), {ok: true, client: {name, version: '2.1.323'}, conditions: 'claude-code'});
    assert.strictEqual(may({name, version: '2.1.323'}, {elicitation: {form: {}, url: {}}}).ok, true);
    withTested(['2.9.0', '2.10.2']);
    assert.strictEqual(may({name, version: '2.10.1'}).ok, true, 'numeric, not string, comparison');
  });

  it('the upper bound is exact and exclusive: the next version is untested; several ranges', () => {
    withTested(['2.1.323', '2.1.324'], ['2.2.0', '2.2.1']);
    assert.deepStrictEqual(may({name, version: '2.1.324'}), {ok: false, why: 'version not in a tested range'});
    assert.deepStrictEqual(may({name, version: '2.1.322'}), {ok: false, why: 'version not in a tested range'});
    assert.deepStrictEqual(may({name, version: '3.0.0'}), {ok: false, why: 'version not in a tested range'});
    assert.strictEqual(may({name, version: '2.2.0'}).ok, true);
  });

  it('a malformed or open range is no range (fails closed); a malformed file is no list', () => {
    for (const r of [{from: '2.0.0'}, {from: '2.0.0', before: null}, {from: '2.0.0', before: '3'}, {from: 'v2.0.0', before: '3.0.0'},
      {from: '3.0.0', before: '2.0.0'}, {from: '2.0.0', before: '2.0.0'}, {from: '2.0.0', before: '3.0.0', extra: 1}, 'x', null]) {
      list = clients.listFrom({clients: [{name, conditions: 'claude-code', tested: [r]}]});
      assert.deepStrictEqual(may({name, version: '2.5.0'}), {ok: false, why: 'not tested yet'}, JSON.stringify(r));
    }
    for (const bad of [null, {}, {clients: 'x'}, {clients: [{name: 1}]}, {clients: [{name, conditions: 'claude-code', tested: 'x'}]}]) {
      list = clients.listFrom(bad);
      assert.strictEqual(may({name, version: '2.5.0'}).ok, false, JSON.stringify(bad));
    }
    assert.ok(Object.isFrozen(clients.listFrom({clients: [{name, conditions: 'claude-code', tested: []}]})[0].tested));
  });

  it('a version that is not plain major.minor.patch may not', () => {
    withTested(['2.0.0', '3.0.0']);
    for (const version of ['2', '2.0', 'v2.0.0', '2.0.0-beta.1', '2.0.0+x', '', null, 20, '02.0.0x', `2.0.${'9'.repeat(40)}`]) {
      assert.deepStrictEqual(may({name, version}), {ok: false, why: 'version not in a tested range'}, String(version));
    }
  });

  it('no form elicitation declared on the request: may not', () => {
    withTested(['2.0.0', '3.0.0']);
    for (const capabilities of [{}, {elicitation: {url: {}}}, {elicitation: null}, {elicitation: true}, null, undefined, {sampling: {}}]) {
      assert.deepStrictEqual(clients.clientMayElicit({clientInfo: {name, version: '2.0.0'}, capabilities}, list), {ok: false, why: 'no elicitation capability'}, JSON.stringify(capabilities));
    }
  });

  it('a name not on the list, in any spelling, may not', () => {
    withTested(['2.0.0', '3.0.0']);
    for (const n of ['Claude-Code', `${name} `, 'claude', 'other', '', null]) {
      assert.deepStrictEqual(may({name: n, version: '2.0.0'}), {ok: false, why: 'not on the tested-client list'}, String(n));
    }
    assert.deepStrictEqual(clients.clientMayElicit({capabilities: FORM}), {ok: false, why: 'not on the tested-client list'});
    assert.deepStrictEqual(clients.clientMayElicit(null), {ok: false, why: 'not on the tested-client list'});
  });
});
