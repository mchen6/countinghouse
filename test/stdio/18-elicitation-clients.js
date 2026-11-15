'use strict';
// lib/elicitation-clients.js (part 3 P2, Task 1): only a client on the
// tested-client list, at or above the version its hand test passed, that
// declares form elicitation on the request itself, may be asked to confirm a
// loosening in a dialog. Until a hand test sets a floor, no client may.
const assert = require('assert');
const clients = require('../../lib/elicitation-clients');

describe('stdio 18: the tested-client allowlist for elicitation (part 3 P2)', () => {
  const FORM = {elicitation: {}};
  const may = (clientInfo, capabilities = FORM) => clients.clientMayElicit({clientInfo, capabilities});
  const name = clients.CLAUDE_CODE;
  let saved = null;
  beforeEach(() => { saved = clients.ALLOWLIST.map((e) => Object.assign({}, e)); });
  afterEach(() => { clients.ALLOWLIST.splice(0, clients.ALLOWLIST.length, ...saved); });
  const withFloor = (floor, ceiling = null) => Object.assign(clients.ALLOWLIST.find((e) => e.name === name), {versionFloor: floor, versionCeiling: ceiling});

  it('ships with no floor: no client is asked until a hand test sets one', () => {
    assert.ok(clients.ALLOWLIST.every((e) => e.versionFloor === null), JSON.stringify(clients.ALLOWLIST));
    assert.deepStrictEqual(may({name, version: '9.9.9'}), {ok: false, why: 'not tested yet'});
  });

  it('a tested client at or above its floor, declaring form elicitation, may', () => {
    withFloor('2.0.0');
    assert.deepStrictEqual(may({name, version: '2.0.0'}), {ok: true, client: {name, version: '2.0.0'}, conditions: 'claude-code'});
    assert.strictEqual(may({name, version: '2.10.1'}).ok, true, 'numeric, not string, comparison');
    assert.strictEqual(may({name, version: '3.0.0'}, {elicitation: {form: {}}}).ok, true);
    assert.strictEqual(may({name, version: '2.0.0'}, {elicitation: {form: {}, url: {}}}).ok, true);
  });

  it('the tested range: at or above the upper bound (exclusive) is untested', () => {
    withFloor('2.0.0', '3.0.0');
    assert.strictEqual(may({name, version: '2.9.9'}).ok, true);
    assert.deepStrictEqual(may({name, version: '3.0.0'}), {ok: false, why: 'version above the tested range'});
    assert.deepStrictEqual(may({name, version: '10.0.0'}), {ok: false, why: 'version above the tested range'});
    assert.ok(clients.ALLOWLIST.every((e) => Object.prototype.hasOwnProperty.call(saved.find((x) => x.name === e.name), 'versionCeiling')), 'every entry has one');
  });

  it('a malformed upper bound fails closed', () => {
    for (const ceiling of ['3', '3.0', 'v3.0.0', 'x']) {
      withFloor('2.0.0', ceiling);
      assert.deepStrictEqual(may({name, version: '5.1.0'}), {ok: false, why: 'version above the tested range'}, ceiling);
    }
  });

  it('below the floor, or a version that is not plain major.minor.patch, may not', () => {
    withFloor('2.0.0');
    for (const version of ['1.9.9', '2', '2.0', 'v2.0.0', '2.0.0-beta.1', '2.0.0+x', '', null, 20, '02.0.0x']) {
      assert.deepStrictEqual(may({name, version}), {ok: false, why: 'version below the tested floor'}, String(version));
    }
  });

  it('no form elicitation declared on the request: may not', () => {
    withFloor('2.0.0');
    for (const capabilities of [{}, {elicitation: {url: {}}}, {elicitation: null}, {elicitation: true}, null, undefined, {sampling: {}}]) {
      assert.deepStrictEqual(clients.clientMayElicit({clientInfo: {name, version: '2.0.0'}, capabilities}), {ok: false, why: 'no elicitation capability'}, JSON.stringify(capabilities));
    }
  });

  it('a name not on the list, in any spelling, may not', () => {
    withFloor('2.0.0');
    for (const n of ['Claude-Code', `${name} `, 'claude', 'other', '', null]) {
      assert.deepStrictEqual(may({name: n, version: '2.0.0'}), {ok: false, why: 'not on the tested-client list'}, String(n));
    }
    assert.deepStrictEqual(clients.clientMayElicit({capabilities: FORM}), {ok: false, why: 'not on the tested-client list'});
    assert.deepStrictEqual(clients.clientMayElicit(null), {ok: false, why: 'not on the tested-client list'});
  });
});
