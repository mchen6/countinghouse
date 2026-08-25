// validate_plan checks a proposed service/action split before any file
// exists, so the user has something readable to approve and the agent gets a
// cheap early failure instead of a slow one after writing four files.
const assert = require('assert');

require('../../lib/cli-options').setOptions({});
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
});
