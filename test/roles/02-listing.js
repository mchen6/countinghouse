// Run with --exit (package.json): requiring the module manager and the tool
// registry leaves a Redis client retrying the unused port, which would keep a
// mocha run without --exit alive.
// Listing (local-mode spec §3 and §4): an unlisted part's actions are not
// tools, a scenario's action is listed under its bare name, a direct
// tools/call to a part is refused MODULE_NOT_LISTED, and the single-identity
// profile lists only the scenarios' tools (the balance and authoring built-ins
// are refused by name). Over a fake interface; Redis is pointed at a port
// nothing listens on before the registry is required.
const assert = require('assert');
const options = require('../../lib/cli-options');
options.setOptions({redisUrl: 'redis://127.0.0.1:9719'});
require('../../lib/logger').createLogger(false);
const toolRegistry = require('../../lib/mcp/tool-registry');
const gateway = require('../../lib/mcp/gateway');
const toolName = require('../../lib/mcp/tool-name');

const spec = (friendlyName, actions) => ({device: {friendlyName, serviceList: {'urn:x:serviceID:svc': {actionList: actions.map((a) => ({name: a, description: `${a} it`}))}}}});

// A scenario with two parts, the parts pulled in by it, and a plain module.
function fakeInterface({unlisted = ['@countinghouse/ch-step-a', 'ch-step-b']} = {}) {
  const devices = {
    d1: {spec: spec('ch-pack-x', ['ci_failure_triage']), packageInfo: {name: '@countinghouse/ch-pack-x', countinghouse: {role: 'scenario'}}},
    d2: {spec: spec('ch-step-a', ['run']), packageInfo: {name: '@countinghouse/ch-step-a', countinghouse: {role: 'part'}}},
    d3: {spec: spec('ch-step-b', ['run']), packageInfo: {name: 'ch-step-b', countinghouse: {role: 'part'}}},
    d4: {spec: spec('plain', ['go']), packageInfo: {name: 'plain'}}
  };
  return {deviceManager: {
    deviceMap: devices,
    moduleManager: {unlisted: new Set(unlisted)},
    getAllDeviceSpecs: () => Object.fromEntries(Object.entries(devices).map(([id, d]) => [id, d.spec]))
  }};
}
const call = (ci, name) => new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: {}}}, ci, null, (err, r) => resolve(r)));
const codeOf = (r) => r.result && r.result._meta && r.result._meta['countinghouse/code'];

describe('listing: roles, bare names, MODULE_NOT_LISTED, the single-identity profile', () => {
  afterEach(() => { options.singleIdentity = false; });

  it('unlisted parts are not tools; a scenario is listed under its bare action name; others keep the long form', () => {
    assert.deepStrictEqual(Object.keys(toolRegistry.buildToolTargets(fakeInterface())).sort(), ['ci_failure_triage', 'plain_svc_go']);
  });

  it('a part loaded on its own is listed under the long form', () => {
    assert.deepStrictEqual(Object.keys(toolRegistry.buildToolTargets(fakeInterface({unlisted: []}))).sort(), ['ch_step_a_svc_run', 'ch_step_b_svc_run', 'ci_failure_triage', 'plain_svc_go']);
  });

  it('a tools/call to an unlisted part, from outside, is refused MODULE_NOT_LISTED', async () => {
    const r = await call(fakeInterface(), 'ch_step_a_svc_run');
    assert.strictEqual(r.result.isError, true, JSON.stringify(r));
    assert.strictEqual(codeOf(r), 'MODULE_NOT_LISTED');
    const unknown = await call(fakeInterface(), 'never_was_a_tool');
    assert.match(unknown.error.message, /unknown tool/, 'a name that is no module stays "unknown tool"');
  });

  it('the single-identity profile lists only the scenarios\' tools, and refuses the built-ins it hides by name', async () => {
    options.singleIdentity = true;
    assert.deepStrictEqual(Object.keys(toolRegistry.buildToolTargets(fakeInterface())), ['ci_failure_triage']);
    assert.ok(!toolRegistry.platformTools().some((t) => t.name === 'countinghouse_check_balance'), 'no balance exists in the profile');
    for (const name of ['countinghouse_check_balance', 'countinghouse_lookup_identity', 'plain_svc_go']) {
      const r = await call(fakeInterface(), name);
      assert.strictEqual(codeOf(r), 'MODULE_NOT_LISTED', name);
      assert.ok(!/key|balance|free call|rate limit/i.test(r.result.content[0].text), `no tenant vocabulary: ${r.result.content[0].text}`);
    }
  });

  it('the reserved names tool-name.js knows are exactly the registry\'s built-ins', () => {
    assert.deepStrictEqual([...toolName.RESERVED_TOOL_NAMES].sort(), [...Object.keys(toolRegistry.PLATFORM_TOOL_NAMES), ...Object.keys(toolRegistry.AUTHORING_TOOL_NAMES)].sort());
  });
});
