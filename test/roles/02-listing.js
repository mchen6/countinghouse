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
// (the options are set in each describe's before(), the process's put back
// in its after(): never at load, which every file of a folder run would
// see -- B-loadopts-2)
const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
require('../../lib/logger').createLogger();
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
  let keptOptions = null;
  before(() => { keptOptions = optionsNow(); options.setOptions({redisUrl: 'redis://127.0.0.1:9749'}); });
  after(() => { restoreOptions(keptOptions); });
  // (--debug: every device granted, and a caller with no key resolved, so
  // what is looked at is the listing; since #458 tools/call refuses an
  // unresolvable caller before any name, auth 54 and mcp-contract 40's)
  let savedDebug;
  before(() => { savedDebug = options.debug; options.debug = true; });
  after(() => { options.debug = savedDebug; });
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

  // (a built-in the profile hides is a name the caller can't use: answered
  // as a name never registered, #458's second high round, 3; a granted
  // caller's unlisted module is still MODULE_NOT_LISTED)
  it('the single-identity profile lists only the scenarios\' tools; a built-in it hides is an unknown tool, a module it hides MODULE_NOT_LISTED', async () => {
    options.singleIdentity = true;
    assert.deepStrictEqual(Object.keys(toolRegistry.buildToolTargets(fakeInterface())), ['ci_failure_triage']);
    assert.ok(!toolRegistry.platformTools().some((t) => t.name === 'countinghouse_check_balance'), 'no balance exists in the profile');
    assert.ok(toolRegistry.platformTools().some((t) => t.name === 'countinghouse_usage_report'), 'the usage report is listed in every mode');
    const never = await call(fakeInterface(), 'no_such_tool');
    const scrub = (r, name) => JSON.stringify(r).split(name).join('<name>');
    for (const name of ['countinghouse_check_balance', 'countinghouse_lookup_identity']) {
      const r = await call(fakeInterface(), name);
      assert.strictEqual(scrub(r, name), scrub(never, 'no_such_tool'), name);
    }
    const r = await call(fakeInterface(), 'plain_svc_go');
    assert.strictEqual(codeOf(r), 'MODULE_NOT_LISTED');
    assert.ok(!/key|balance|free call|rate limit/i.test(r.result.content[0].text), `no tenant vocabulary: ${r.result.content[0].text}`);
  });

  // F3-5 (Fable pass over the MCP surface): a module whose worker exited keeps its devices' specs with its
  // supervisor while it restarts or is suspended, out of the device map; their listing (and a call's refusal)
  // is decided by the module that owns the device ID, as while it ran
  describe('a restarting or suspended module\'s retained devices (F3-5)', () => {
    const ModuleSupervisor = require('../../lib/module-supervisor');
    // the fake interface, with these devices' workers exited: out of the device map, their specs with the supervisor
    function exitedInterface(gone, {unlisted, keepPackage = true, exits = 1} = {}) {
      const ci = fakeInterface(unlisted != null ? {unlisted} : {});
      const dm = ci.deviceManager;
      const all = dm.getAllDeviceSpecs();
      const supervisor = new ModuleSupervisor({setTimer: () => ({}), clearTimer: () => {}, restart: () => {}});
      // every device ID registered, as DeviceManager registerFromSpec keeps them
      dm.deviceOwners = new Map(Object.entries(dm.deviceMap).map(([id, d]) => [id, d.packageInfo.name]));
      // the device manager's own answer of a device's module, in the map or out of it
      dm.moduleOfDevice = require('../../lib/device-manager').prototype.moduleOfDevice;
      dm.packageOfModule = require('../../lib/device-manager').prototype.packageOfModule;
      dm.moduleManager.modules = {};
      for (const id of gone) {
        const {packageInfo} = dm.deviceMap[id];
        supervisor.track(packageInfo.name, {modulePath: `/m/${packageInfo.name}`, version: '1.0.0'});
        for (let i = 0; i < exits; i++) supervisor.exited(packageInfo.name, 'exit code 1', {[id]: all[id]}, keepPackage ? packageInfo : undefined);
        delete dm.deviceMap[id];
      }
      dm.moduleManager.supervisor = supervisor;
      dm.getAllDeviceSpecs = () => Object.assign(Object.fromEntries(Object.entries(dm.deviceMap).map(([id, d]) => [id, d.spec])), supervisor.retainedSpecs());
      return ci;
    }

    it('an unlisted part restarting, or suspended, is still no tool, and is marked unlisted', () => {
      for (const exits of [1, 3]) {
        const ci = exitedInterface(['d2', 'd3'], {exits});
        assert.deepStrictEqual(Object.keys(toolRegistry.buildToolTargets(ci)).sort(), ['ci_failure_triage', 'plain_svc_go'], `${exits} exit(s)`);
        assert.deepStrictEqual([toolRegistry.listingOf(ci, 'd2'), toolRegistry.listingOf(ci, 'd3')], [{role: 'part', listed: false}, {role: 'part', listed: false}]);
      }
    });

    it('a scenario restarting keeps its bare name, and a listed module stays listed (clients get no list_changed)', () => {
      const ci = exitedInterface(['d1', 'd4']);
      assert.deepStrictEqual(Object.keys(toolRegistry.buildToolTargets(ci)).sort(), ['ci_failure_triage', 'plain_svc_go']);
      // a part loaded on its own, restarting: listed, as while it ran
      assert.deepStrictEqual(Object.keys(toolRegistry.buildToolTargets(exitedInterface(['d2'], {unlisted: []}))).sort(), ['ch_step_a_svc_run', 'ch_step_b_svc_run', 'ci_failure_triage', 'plain_svc_go']);
    });

    it('the single-identity profile lists a restarting scenario, and not a restarting module that is no scenario', () => {
      options.singleIdentity = true;
      assert.deepStrictEqual(Object.keys(toolRegistry.buildToolTargets(exitedInterface(['d1', 'd2', 'd4'], {unlisted: []}))), ['ci_failure_triage']);
    });

    it('kept with no package.json (it exited before its devices registered): decided by its module\'s name', () => {
      const ci = exitedInterface(['d2', 'd4'], {keepPackage: false});
      assert.deepStrictEqual(Object.keys(toolRegistry.buildToolTargets(ci)).sort(), ['ci_failure_triage', 'plain_svc_go'], 'the part unlisted, the plain module listed');
      assert.deepStrictEqual([toolRegistry.listingOf(ci, 'd2'), toolRegistry.listingOf(ci, 'd4')], [{role: null, listed: false}, {role: null, listed: true}]);
    });

    it('back after its restart, before its devices register again: decided by the new worker\'s own pin', () => {
      const ci = exitedInterface(['d2', 'd4']);
      const mm = ci.deviceManager.moduleManager;
      for (const name of ['@countinghouse/ch-step-a', 'plain']) mm.supervisor.track(name, {modulePath: `/m/${name}`, version: '1.0.0'});
      // the new workers are up (the module manager's map), their devices not registered yet
      mm.modules['@countinghouse/ch-step-a'] = {hostModulePath: '/m/@countinghouse/ch-step-a', hostPackageInfo: {name: '@countinghouse/ch-step-a', countinghouse: {role: 'part'}}};
      mm.modules.plain = {hostModulePath: '/m/plain', hostPackageInfo: {name: 'plain'}};
      assert.deepStrictEqual([toolRegistry.listingOf(ci, 'd2'), toolRegistry.listingOf(ci, 'd4')], [{role: 'part', listed: false}, {role: null, listed: true}]);
      // a new worker with no pin: the package.json the supervisor kept, so its role holds until its devices register
      mm.modules['@countinghouse/ch-step-a'] = {hostModulePath: '/m/@countinghouse/ch-step-a', hostPackageInfo: null};
      assert.deepStrictEqual(toolRegistry.listingOf(ci, 'd2'), {role: 'part', listed: false});
      // and with nothing kept either (a first worker): as its devices will register, its name alone
      mm.supervisor.clear('@countinghouse/ch-step-a');
      assert.deepStrictEqual(toolRegistry.listingOf(ci, 'd2'), {role: null, listed: false}, 'unlisted by name');
    });

    it('a device no module is known for is answered as before: no spec of it is listed, and a call gets its own code', () => {
      const ci = exitedInterface(['d2']);
      assert.deepStrictEqual(toolRegistry.listingOf(ci, 'never-a-device'), {role: null, listed: true});
      options.singleIdentity = true;
      assert.deepStrictEqual(toolRegistry.listingOf(ci, 'never-a-device'), {role: null, listed: false});
    });

    it('a tools/call to a restarting unlisted part, from outside, is refused MODULE_NOT_LISTED', async () => {
      const r = await call(exitedInterface(['d2']), 'ch_step_a_svc_run');
      assert.strictEqual(codeOf(r), 'MODULE_NOT_LISTED', JSON.stringify(r));
    });
  });

  it('the reserved names tool-name.js knows are exactly the registry\'s built-ins', () => {
    assert.deepStrictEqual([...toolName.RESERVED_TOOL_NAMES].sort(), [...Object.keys(toolRegistry.PLATFORM_TOOL_NAMES), ...Object.keys(toolRegistry.AUTHORING_TOOL_NAMES)].sort());
  });
});
