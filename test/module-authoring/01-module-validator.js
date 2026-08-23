// Unit cover for lib/module-validator.js -- the standalone oracle behind
// bin/countinghouse-validate and the countinghouse_validate_module MCP tool.
//
// These run in-process against fixtures that are each broken in exactly one
// way, with no Redis and no server: that independence is the whole point of
// the extraction, so a test file that needed either would be testing the
// wrong thing.
const assert = require('assert');
const path   = require('path');

require('../../lib/cli-options').setOptions({});
const moduleValidator = require('../../lib/module-validator');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const fixture  = (name) => path.join(FIXTURES, name);

describe('module-validator: a well-formed module', () => {
  it('reports ok with no problems', (done) => {
    moduleValidator.validateModule(fixture('handler-map-convention'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.problems, []);
      done();
    });
  });

  it('names the module it validated', (done) => {
    moduleValidator.validateModule(fixture('handler-map-convention'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.module, 'handler-map-convention');
      done();
    });
  });
});

describe('module-validator: handler-map mismatches', () => {
  it('reports a handler service that api.json does not declare', (done) => {
    moduleValidator.validateModule(fixture('handler-map-unknown-service'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      // both directions of the strict check fire for this fixture
      assert.strictEqual(result.problems.length, 2);
      assert.ok(result.problems.every((p) => p.stage === 'assembleHandlerMap'));
      assert.ok(result.problems.some((p) => /declares service "greetingService"/.test(p.message)));
      done();
    });
  });

  it('reports a declared action with no handler', (done) => {
    moduleValidator.validateModule(fixture('handler-map-missing-action'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.problems.length, 1);
      assert.ok(/declares action "greetService.hello"/.test(result.problems[0].message));
      done();
    });
  });

  it('reports a handler for an action api.json does not declare', (done) => {
    moduleValidator.validateModule(fixture('handler-map-undeclared-action'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.problems.length, 1);
      assert.ok(/"greetService.goodbye"/.test(result.problems[0].message));
      done();
    });
  });

  it('collects every problem rather than stopping at the first', (done) => {
    // the point of the extraction: an author who renamed a service wants the
    // whole list, not one problem per re-run
    moduleValidator.validateModule(fixture('handler-map-unknown-service'), (err, result) => {
      assert.ifError(err);
      assert.ok(result.problems.length > 1);
      done();
    });
  });
});

describe('module-validator: spec problems', () => {
  it('reports a spec that fails the meta-schema, with the instance path', (done) => {
    moduleValidator.validateModule(fixture('invalid-spec-module'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      const spec = result.problems.filter((p) => p.stage === 'validateDeviceSpec');
      assert.ok(spec.length > 0, 'expected at least one validateDeviceSpec problem');
      done();
    });
  });

  it('names the migrator for a pre-5.0.0 spec instead of an ajv symptom', (done) => {
    moduleValidator.validateModule(fixture('legacy-spec-module'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      assert.ok(result.problems.some((p) => /countinghouse-migrate-spec/.test(p.message)));
      done();
    });
  });
});

describe('module-validator: unusable input', () => {
  it('errors when the directory does not exist', (done) => {
    moduleValidator.validateModule(fixture('no-such-module-anywhere'), (err) => {
      assert.ok(err != null, 'expected an error for a missing directory');
      done();
    });
  });

  it('reports a missing api.json as a problem, not a crash', (done) => {
    moduleValidator.validateModule(FIXTURES, (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      assert.ok(result.problems.some((p) => p.stage === 'readApiJson'));
      done();
    });
  });
});
