// validate_plan checks a proposed service/action split before any file
// exists, so the user has something readable to approve and the agent gets a
// cheap early failure instead of a slow one after writing four files.
const assert = require('assert');

require('../../lib/cli-options').setOptions({});
const planValidator = require('../../lib/plan-validator');

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
