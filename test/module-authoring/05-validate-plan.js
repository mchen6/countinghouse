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
  // Shaped like lib/mcp/tool-registry.js's buildToolTargets() output: a
  // name -> {deviceID, serviceID, actionName, ...} map for one loaded
  // "repo-scan" module exposing scanService.scan.
  const targets = {
    repo_scan_scanservice_scan: {
      name:       'repo_scan_scanservice_scan',
      deviceID:   callAddress.deviceIDForName('repo-scan'),
      serviceID:  'urn:countinghouse-com:scanService',
      actionName: 'scan'
    }
  };

  it('reports a malformed address regardless of whether targets are given', () => {
    const plan = Object.assign({}, goodPlan, {calls: ['repo-scan.scan']});
    const r = planValidator.validatePlan(plan, []);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => p.stage === 'validatePlan' && /repo-scan\.scan/.test(p.message)));
  });

  it('accepts a well-formed address that resolves against the given targets', () => {
    const plan = Object.assign({}, goodPlan, {calls: ['repo-scan/scanService.scan']});
    const r = planValidator.validatePlan(plan, [], targets);
    assert.strictEqual(r.problems.some((p) => /repo-scan\/scanService\.scan/.test(p.message)), false);
  });

  it('reports a well-formed address matching no loaded target', () => {
    const plan = Object.assign({}, goodPlan, {calls: ['no-such-module/scanService.scan']});
    const r = planValidator.validatePlan(plan, [], targets);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => /no-such-module\/scanService\.scan/.test(p.message)));
  });

  it('skips resolution entirely when targets is omitted (existing callers unaffected)', () => {
    const plan = Object.assign({}, goodPlan, {calls: ['no-such-module/scanService.scan']});
    const r = planValidator.validatePlan(plan, []);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.problems, []);
  });
});
