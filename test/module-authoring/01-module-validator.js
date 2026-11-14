// Unit cover for lib/module-validator.js -- the standalone oracle behind
// bin/countinghouse-validate.js and the countinghouse_validate_module MCP tool.
//
// These run in-process against fixtures that are each broken in exactly one
// way, with no Redis and no server: that independence is the whole point of
// the extraction, so a test file that needed either would be testing the
// wrong thing.
const assert = require('assert');
const path   = require('path');

require('../../lib/cli-options').setOptions({workerThread: false});
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

describe('module-validator: one module format (lib/module-layout.js)', () => {
  it('a main entry with no handlers/ directory is a "layout" problem with the load\'s code and text', (done) => {
    moduleValidator.validateModule(fixture('no-index-module'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      const layout = result.problems.filter((p) => p.stage === 'layout');
      assert.strictEqual(layout.length, 1, JSON.stringify(result.problems));
      assert.strictEqual(layout[0].code, 'MODULE_LAYOUT_UNSUPPORTED');
      assert.match(layout[0].message, /^no-index-module: a module is api\.json, schema\.json and handlers\/<service>\/<action>\.js/);
      assert.match(layout[0].message, /package\.json "main": "device\.js"/);
      done();
    });
  });

  // handler-map-entry-throws: an index.js that throws, beside a valid
  // handlers/ tree. A main entry is never run, by the runtime or the
  // validator, so the module is clean (before the one format, the validator
  // required it and reported a loadModuleEntry problem).
  it('a module with handlers/ is clean whatever its main entry does: the main entry is never run', (done) => {
    moduleValidator.validateModule(fixture('handler-map-entry-throws'), (err, result) => {
      assert.ifError(err);
      assert.deepStrictEqual(result.problems, []);
      assert.strictEqual(result.ok, true);
      done();
    });
  });
});

describe('module-validator: countinghouse.calls', () => {
  it('reports a malformed address', (done) => {
    moduleValidator.validateModule(fixture('bad-calls-module'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      const problem = result.problems.find((p) => p.stage === 'countinghouse.calls');
      assert.ok(problem != null, 'a calls problem should be reported');
      assert.ok(/repo-scan\.scan/.test(problem.message));
      done();
    });
  });

  it('accepts a well-formed calls list', (done) => {
    // compose-caller's package.json carries a real, non-empty
    // countinghouse.calls array (two valid addresses) -- unlike
    // handler-map-convention, which has no countinghouse key at all and so
    // would pass this assertion even if the parse-success branch were
    // broken or callsProblems were never called. This fixture actually
    // exercises parseAddress's accept path.
    moduleValidator.validateModule(fixture('compose-caller'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.problems.some((p) => p.stage === 'countinghouse.calls'), false,
        `expected no countinghouse.calls problems, got: ${JSON.stringify(result.problems)}`);
      done();
    });
  });

  it('reports a duplicate address', (done) => {
    moduleValidator.validateModule(fixture('duplicate-calls-module'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      const problem = result.problems.find((p) =>
        p.stage === 'countinghouse.calls' && /more than once/.test(p.message));
      assert.ok(problem != null,
        `expected a duplicate countinghouse.calls problem, got: ${JSON.stringify(result.problems)}`);
      assert.ok(/repo-scan\/scanService\.scan/.test(problem.message));
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
