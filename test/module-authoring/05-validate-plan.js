// validate_plan checks a proposed service/action split before any file
// exists, so the user has something readable to approve and the agent gets a
// cheap early failure instead of a slow one after writing four files.
const assert = require('assert');

// (the options are set in each describe's before(), the process's put back
// in its after(): never at load, which every file of a folder run would
// see -- B-loadopts-2)
const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
const planValidator = require('../../lib/plan-validator');
const callAddress   = require('../../lib/call-address');

const goodPlan = {
  device: 'log-review',
  services: [{
    name: 'reviewService',
    actions: [{name: 'summarize', description: 'Summarize error logs by service.'}]
  }]
};

describe('plan-validator', () => {
  let keptOptions = null;
  before(() => { keptOptions = optionsNow(); require('../../lib/cli-options').setOptions({workerThread: false}); });
  after(() => { restoreOptions(keptOptions); });
  it('accepts a well-formed plan', () => {
    const r = planValidator.validatePlan(goodPlan, []);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.problems, []);
  });

  it('rejects a plan with no services', () => {
    const r = planValidator.validatePlan({device: 'x', services: []}, []);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => p.stage === 'validatePlan'));
  });

  it('rejects an action with no description, which MCP needs', () => {
    const plan = {device: 'x', services: [{name: 'svc', actions: [{name: 'go'}]}]};
    const r = planValidator.validatePlan(plan, []);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => /description/.test(p.message)));
  });

  it('rejects two services sharing a short name', () => {
    const plan = {device: 'x', services: [
      {name: 'svc', actions: [{name: 'a', description: 'd'}]},
      {name: 'svc', actions: [{name: 'b', description: 'd'}]}
    ]};
    const r = planValidator.validatePlan(plan, []);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => /ambiguous|duplicate/i.test(p.message)));
  });

  it('rejects two actions sharing a name within one service', () => {
    const plan = {device: 'x', services: [
      {name: 'svc', actions: [{name: 'a', description: 'd'}, {name: 'a', description: 'd'}]}
    ]};
    const r = planValidator.validatePlan(plan, []);
    assert.strictEqual(r.ok, false);
  });

  it('reports a collision with a tool already on the runtime', () => {
    const r = planValidator.validatePlan(goodPlan, ['log_review_reviewservice_summarize']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => /already/i.test(p.message)));
  });

  it('reports the tool names the plan would produce', () => {
    const r = planValidator.validatePlan(goodPlan, []);
    assert.ok(Array.isArray(r.toolNames));
    assert.strictEqual(r.toolNames.length, 1);
  });
});

describe('plan-validator: plan.calls', () => {
  let keptOptions = null;
  before(() => { keptOptions = optionsNow(); require('../../lib/cli-options').setOptions({workerThread: false}); });
  after(() => { restoreOptions(keptOptions); });
  // Shaped like DeviceManager.prototype.getAllDeviceSpecs() output: a
  // deviceID -> device-spec map for one loaded "repo-scan" module exposing
  // scanService.scan. Deliberately includes an action with NO description --
  // buildToolTargets would skip it, but ctx.call resolves through the raw
  // spec and does not care, so validate_plan must not report it as unresolved.
  const specs = {
    [callAddress.deviceIDForName('repo-scan')]: {
      device: {
        friendlyName: 'repo-scan',
        serviceList: {
          'urn:countinghouse-com:scanService': {
            actionList: [
              {name: 'scan'},              // no description on purpose
              {name: 'undescribedAction'}  // ditto
            ]
          }
        }
      }
    }
  };

  it('reports a malformed address regardless of whether specs are given', () => {
    const plan = Object.assign({}, goodPlan, {calls: ['repo-scan.scan']});
    const r = planValidator.validatePlan(plan, []);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => p.stage === 'validatePlan' && /repo-scan\.scan/.test(p.message)));
  });

  it('accepts a well-formed address that resolves against the given specs, even with no description', () => {
    const plan = Object.assign({}, goodPlan, {calls: ['repo-scan/scanService.scan']});
    const r = planValidator.validatePlan(plan, [], specs);
    assert.strictEqual(r.problems.some((p) => /repo-scan\/scanService\.scan/.test(p.message)), false);
    // The strengthened assertion: a prior version of this test only checked
    // that the specific address wasn't reported unresolved, which would
    // have stayed green even if an unrelated bug (e.g. an undetected
    // duplicate) made r.ok false for the wrong reason.
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  });

  it('reports a well-formed address matching no loaded target', () => {
    const plan = Object.assign({}, goodPlan, {calls: ['no-such-module/scanService.scan']});
    const r = planValidator.validatePlan(plan, [], specs);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => /no-such-module\/scanService\.scan/.test(p.message)));
  });

  it('skips resolution entirely when specs is omitted (existing callers unaffected)', () => {
    const plan = Object.assign({}, goodPlan, {calls: ['no-such-module/scanService.scan']});
    const r = planValidator.validatePlan(plan, []);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.problems, []);
  });

  // RECOMMENDED 8: lib/module-validator.js already rejects a duplicate
  // address in package.json's "countinghouse.calls" -- plan-validator.js
  // checks the identical shape in plan.calls and, until now, did not, so a
  // plan could pass validate_plan and then have the same list fail
  // validate_module once written out as package.json.
  it('reports a duplicate address within plan.calls', () => {
    const plan = Object.assign({}, goodPlan,
      {calls: ['repo-scan/scanService.scan', 'repo-scan/scanService.scan']});
    const r = planValidator.validatePlan(plan, [], specs);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => p.stage === 'validatePlan' && /more than once/.test(p.message)),
      JSON.stringify(r.problems));
  });

  // (the medium on the dry run's naming fix) a scenario's tools are named by
  // their action alone: two services' same action is one name, a reserved
  // name is countinghouse's own, and a collision is fixed by the action
  describe('a scenario\'s plan (role scenario)', () => {
    const svc = (name, action) => ({name, actions: [{name: action, description: 'does a thing'}]});
    it('the same action in two services: one name twice, a problem', () => {
      const r = planValidator.validatePlan({device: 'x', services: [svc('aService', 'run'), svc('bService', 'run')]}, [], {}, {role: 'scenario'});
      assert.deepStrictEqual(r.toolNames, ['run', 'run']);
      assert.strictEqual(r.ok, false);
      assert.ok(r.problems.some((p) => p.message === '"run" is the tool name of two actions in this plan.'), JSON.stringify(r.problems));
    });
    it('an action named as one of countinghouse\'s own tools: a problem', () => {
      const r = planValidator.validatePlan({device: 'x', services: [svc('aService', 'countinghouse_settings')]}, [], {}, {role: 'scenario'});
      assert.strictEqual(r.ok, false);
      assert.ok(r.problems.some((p) => p.message === '"countinghouse_settings" is a name countinghouse keeps for its own tools.'), JSON.stringify(r.problems));
    });
    it('a collision with a tool on this runtime: rename the action', () => {
      const r = planValidator.validatePlan({device: 'x', services: [svc('aService', 'countLines')]}, ['countlines'], {}, {role: 'scenario'});
      const p = r.problems.find((x) => x.message === '"countlines" is already a tool on this runtime.');
      assert.ok(p != null, JSON.stringify(r.problems));
      assert.strictEqual(p.fix, 'Rename the action: a scenario\'s tool is named by its action alone.');
    });
  });
});
