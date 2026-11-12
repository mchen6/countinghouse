// Run with --exit (package.json): requiring the module manager and the tool
// registry leaves a Redis client retrying the unused port, which would keep a
// mocha run without --exit alive.
// lib/module-roles.js (local-mode spec §3): a module's role, the parts a
// scenario declares in countinghouse.calls, where those parts are found, and
// the load list --loadModule expands to, with listed set per module. Pure
// over temporary module trees: no server.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const roles = require('../../lib/module-roles');

// A module directory: package.json and an api.json with one action per name.
function moduleAt(dir, {name, friendlyName = name.replace(/^@[^/]+\//, ''), role, calls, actions = ['run']}) {
  fs.mkdirSync(dir, {recursive: true});
  const ch = {};
  if (role !== undefined) ch.role = role;
  if (calls !== undefined) ch.calls = calls;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', ...(Object.keys(ch).length ? {countinghouse: ch} : {})}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName, serviceList: {'urn:x:serviceID:svc': {actionList: actions.map((a) => ({name: a, description: a}))}}}}));
  return dir;
}

describe('module roles, scenarios and parts', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-roles-')); });
  afterEach(() => { fs.rmSync(root, {recursive: true, force: true}); });

  // An app laid out as the launcher installs it: every package under node_modules.
  function app() {
    const nm = path.join(root, 'node_modules');
    const scenario = moduleAt(path.join(nm, '@countinghouse', 'ch-pack-x'), {name: '@countinghouse/ch-pack-x', role: 'scenario', actions: ['ci_failure_triage'],
      calls: ['ch-step-a/svc.run', 'ch-step-b/svc.run', 'ch-step-a/svc.other']});
    moduleAt(path.join(nm, '@countinghouse', 'ch-step-a'), {name: '@countinghouse/ch-step-a', role: 'part'});
    moduleAt(path.join(nm, 'ch-step-b'), {name: 'ch-step-b', role: 'part'});
    return {scenario, nm};
  }

  it('reads the role, and the parts a scenario calls, each once', () => {
    const {scenario} = app();
    const pkg = JSON.parse(fs.readFileSync(path.join(scenario, 'package.json'), 'utf8'));
    assert.strictEqual(roles.roleOf(pkg), 'scenario');
    assert.strictEqual(roles.roleOf({name: 'x'}), null);
    assert.strictEqual(roles.roleOf({countinghouse: {role: 'odd'}}), null);
    assert.deepStrictEqual(roles.partsOf(pkg), ['ch-step-a', 'ch-step-b']);
  });

  it('a part is found by its bare name, or under a scope, from the scenario\'s directory, and must be the module asked for', () => {
    const {scenario, nm} = app();
    assert.strictEqual(roles.resolvePart('ch-step-b', scenario), path.join(nm, 'ch-step-b'));
    assert.strictEqual(roles.resolvePart('ch-step-a', scenario), path.join(nm, '@countinghouse', 'ch-step-a'));
    assert.strictEqual(roles.resolvePart('ch-step-missing', scenario), null);
    // A package of that name whose api.json is another module is not it.
    moduleAt(path.join(nm, 'ch-step-c'), {name: 'ch-step-c', friendlyName: 'something-else'});
    assert.strictEqual(roles.resolvePart('ch-step-c', scenario), null);
  });

  it('a scenario expands to itself, listed, and its parts, unlisted', () => {
    const {scenario, nm} = app();
    const {load, refused} = roles.expandLoadList([scenario]);
    assert.deepStrictEqual(refused, []);
    assert.deepStrictEqual(load.map((m) => [m.name, m.listed]), [['@countinghouse/ch-pack-x', true], ['@countinghouse/ch-step-a', false], ['ch-step-b', false]]);
    assert.strictEqual(load[2].path, path.join(nm, 'ch-step-b'));
  });

  it('a part loaded directly is listed, as every module is today', () => {
    const {nm} = app();
    const {load} = roles.expandLoadList([path.join(nm, 'ch-step-b')]);
    assert.deepStrictEqual(load.map((m) => [m.name, m.listed]), [['ch-step-b', true]]);
    const plain = moduleAt(path.join(root, 'plain'), {name: 'plain'});
    assert.deepStrictEqual(roles.expandLoadList([plain]).load.map((m) => [m.name, m.listed]), [['plain', true]]);
  });

  it('parts that call parts load recursively, each module once, cycles included', () => {
    const nm = path.join(root, 'node_modules');
    const scenario = moduleAt(path.join(nm, 's'), {name: 's', role: 'scenario', calls: ['p1/svc.run']});
    moduleAt(path.join(nm, 'p1'), {name: 'p1', role: 'part', calls: ['p2/svc.run']});
    moduleAt(path.join(nm, 'p2'), {name: 'p2', role: 'part', calls: ['p1/svc.run']});
    const {load, refused} = roles.expandLoadList([scenario, path.join(nm, 'p1')]);
    assert.deepStrictEqual(refused, []);
    // p1 is also given directly: it loads once, and is listed (a module given directly always is).
    assert.deepStrictEqual(load.map((m) => [m.name, m.listed]), [['s', true], ['p1', true], ['p2', false]]);
  });

  it('a scenario with a missing part does not load, and says which part', () => {
    const {scenario, nm} = app();
    fs.rmSync(path.join(nm, 'ch-step-b'), {recursive: true});
    const other = moduleAt(path.join(root, 'other'), {name: 'other'});
    const {load, refused} = roles.expandLoadList([scenario, other]);
    assert.deepStrictEqual(load.map((m) => m.name), ['other'], 'other modules load normally');
    assert.deepStrictEqual(refused, [{name: '@countinghouse/ch-pack-x', path: scenario, code: 'PART_MISSING', part: 'ch-step-b'}]);
  });

  it('a part missing deeper down refuses the scenario too', () => {
    const nm = path.join(root, 'node_modules');
    const scenario = moduleAt(path.join(nm, 's'), {name: 's', role: 'scenario', calls: ['p1/svc.run']});
    moduleAt(path.join(nm, 'p1'), {name: 'p1', role: 'part', calls: ['gone/svc.run']});
    const {load, refused} = roles.expandLoadList([scenario]);
    assert.deepStrictEqual(load, []);
    assert.deepStrictEqual(refused.map((r) => [r.name, r.code, r.part]), [['s', 'PART_MISSING', 'gone']]);
  });

  it('a scenario\'s tool takes its bare name, refused when it collides with a listed tool or a built-in', () => {
    const {scenario} = app();
    assert.deepStrictEqual(roles.toolNamesOf(scenario, 'scenario'), ['ci_failure_triage']);
    assert.deepStrictEqual(roles.toolNamesOf(moduleAt(path.join(root, 'm'), {name: 'm', friendlyName: 'My Mod'}), null), ['my_mod_svc_run']);
    // The built-in's name, and a listed module whose long name is the same bare name.
    const s2 = moduleAt(path.join(root, 's2'), {name: 's2', role: 'scenario', actions: ['countinghouse_check_balance']});
    const s3 = moduleAt(path.join(root, 's3'), {name: 's3', role: 'scenario', actions: ['plain_svc_run']});
    const plain = moduleAt(path.join(root, 'plain'), {name: 'plain'});
    const {load, refused} = roles.expandLoadList([scenario, s2, s3, plain], {reserved: ['countinghouse_check_balance']});
    assert.deepStrictEqual(load.map((m) => m.name).sort(), ['@countinghouse/ch-pack-x', '@countinghouse/ch-step-a', 'ch-step-b', 'plain']);
    assert.deepStrictEqual(refused.map((r) => [r.name, r.code, r.tool, r.with]), [
      ['s2', 'TOOL_NAME_TAKEN', 'countinghouse_check_balance', 'a runtime built-in'],
      ['s3', 'TOOL_NAME_TAKEN', 'plain_svc_run', 'plain']
    ]);
  });

  it('two scenarios with the same bare tool name: the second is refused', () => {
    const a = moduleAt(path.join(root, 'a'), {name: 'a', role: 'scenario', actions: ['triage']});
    const b = moduleAt(path.join(root, 'b'), {name: 'b', role: 'scenario', actions: ['triage']});
    const {load, refused} = roles.expandLoadList([a, b]);
    assert.deepStrictEqual(load.map((m) => m.name), ['a']);
    assert.deepStrictEqual(refused.map((r) => [r.name, r.tool, r.with]), [['b', 'triage', 'a']]);
  });
});

describe('expansion, from /code-review medium on #46', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-roles-r-')); });
  afterEach(() => { fs.rmSync(root, {recursive: true, force: true}); });

  it('a refused scenario does not take away a part that another scenario also needs', () => {
    const nm = path.join(root, 'node_modules');
    const a = moduleAt(path.join(nm, 'a'), {name: 'a', role: 'scenario', calls: ['p1/svc.run'], actions: ['countinghouse_check_balance']});
    const b = moduleAt(path.join(nm, 'b'), {name: 'b', role: 'scenario', calls: ['p1/svc.run'], actions: ['b_tool']});
    moduleAt(path.join(nm, 'p1'), {name: 'p1', role: 'part'});
    const {load, refused} = roles.expandLoadList([a, b], {reserved: ['countinghouse_check_balance']});
    assert.deepStrictEqual(refused.map((r) => [r.name, r.code]), [['a', 'TOOL_NAME_TAKEN']]);
    assert.deepStrictEqual(load.map((m) => [m.name, m.listed]), [['b', true], ['p1', false]]);
  });

  it('a part loaded directly brings the parts it calls, unlisted, and stays listed itself', () => {
    const nm = path.join(root, 'node_modules');
    moduleAt(path.join(nm, 'p1'), {name: 'p1', role: 'part', calls: ['p2/svc.run']});
    moduleAt(path.join(nm, 'p2'), {name: 'p2', role: 'part'});
    assert.deepStrictEqual(roles.expandLoadList([path.join(nm, 'p1')]).load.map((m) => [m.name, m.listed]), [['p1', true], ['p2', false]]);
  });

  it('a module given directly is listed whatever the order of --loadModule', () => {
    const nm = path.join(root, 'node_modules');
    const s = moduleAt(path.join(nm, 's'), {name: 's', role: 'scenario', calls: ['p1/svc.run']});
    const p1 = moduleAt(path.join(nm, 'p1'), {name: 'p1', role: 'part'});
    for (const order of [[s, p1], [p1, s]]) {
      const listed = Object.fromEntries(roles.expandLoadList(order).load.map((m) => [m.name, m.listed]));
      assert.deepStrictEqual(listed, {s: true, p1: true}, order.map((d) => path.basename(d)).join(','));
    }
  });

  it('an action with no description is never a tool, so it takes no name', () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'package.json'), JSON.stringify({name: 'plain', version: '1.0.0'}));
    fs.writeFileSync(path.join(plain, 'api.json'), JSON.stringify({device: {friendlyName: 'triage', serviceList: {'urn:x:serviceID:run': {actionList: [{name: 'it'}]}}}}));
    const s = moduleAt(path.join(root, 's'), {name: 's', role: 'scenario', actions: ['triage_run_it']});
    assert.deepStrictEqual(roles.expandLoadList([plain, s]).refused, []);
  });
});

describe('--loadModule expands a scenario in the module manager', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-roles-mm-')); });
  afterEach(() => { fs.rmSync(root, {recursive: true, force: true}); });

  it('the load list holds the scenario and its parts, and the parts are recorded unlisted', () => {
    const options = require('../../lib/cli-options');
    options.setOptions({redisUrl: 'redis://127.0.0.1:9719'});
    require('../../lib/logger').createLogger(false);
    const ModuleManager = require('../../lib/module-manager');
    const nm = path.join(root, 'node_modules');
    const scenario = moduleAt(path.join(nm, 's'), {name: 's', role: 'scenario', calls: ['p1/svc.run']});
    moduleAt(path.join(nm, 'p1'), {name: 'p1', role: 'part'});
    const missing = moduleAt(path.join(root, 'lonely'), {name: 'lonely', role: 'scenario', calls: ['nowhere/svc.run']});
    const mm = new ModuleManager();
    assert.deepStrictEqual(mm.getModuleInfoFromPath([scenario, missing]).map((m) => m.name), ['s', 'p1']);
    assert.deepStrictEqual([...mm.unlisted], ['p1']);
  });
});
