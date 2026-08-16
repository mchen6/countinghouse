// An argument object may carry only `input`/`output` and the framework's own
// injected keys (ctx, httpHeaders, jobID). Anything else is rejected.
//
// Drives Service.prototype.validateActionCall directly -- no server, no redis.
// The device is a stub: validateActionCall only ever touches the compiled
// schema objects hung off the action, which are built here by hand rather than
// resolved from a schema.json.
const assert = require('assert');
const Ajv2020 = require('ajv/dist/2020');

const Service = require('../../lib/service');

const ajv = new Ajv2020({allErrors: false, allowUnionTypes: true});

function compiled(schema) {
  return {schema: schema, validator: ajv.compile(schema)};
}

// A Service whose spec declares one action with both directions schema'd.
function makeService() {
  const stubDevice = {
    deviceID: 'stub',
    resolveSchemaFromPath: function() {}   // never called: no pointers in this spec
  };
  const service = new Service(stubDevice, 'urn:test:serviceID:svc', {actionList: []});

  const objectSchema = {type: 'object', properties: {v: {type: 'string'}}, required: ['v']};
  service.actions.act = {
    name:   'act',
    invoke: function() {},
    input:  compiled(objectSchema),
    output: compiled(objectSchema)
  };
  return service;
}

function validate(args, isInput) {
  const result = {};
  makeService().validateActionCall(makeService().actions.act, args, isInput, (err, data) => {
    result.err = err;
    result.data = data;
  });
  return result;
}

describe('validation 01: unknown arguments are rejected, not ignored', () => {

  it('accepts a well-formed input argument', () => {
    const r = validate({input: {v: 'x'}}, true);
    assert.strictEqual(r.err, null, r.err && r.err.message);
  });

  it('accepts the framework-injected keys alongside it', () => {
    const r = validate({input: {v: 'x'}, ctx: {}, httpHeaders: {}, jobID: 7}, true);
    assert.strictEqual(r.err, null, r.err && r.err.message);
  });

  it('rejects an unknown key on the way in, naming it', () => {
    const r = validate({input: {v: 'x'}, surprise: 1}, true);
    assert.ok(r.err != null, 'an unknown input argument must not be accepted');
    assert.strictEqual(r.err.code, 'INPUT_DATA_VALIDATION_FAIL');
    assert.strictEqual(r.data.fault.reason, 'unexpected input argument: surprise');
  });

  it('rejects an unknown key on the way out, naming it', () => {
    const r = validate({output: {v: 'x'}, surprise: 1}, false);
    assert.ok(r.err != null, 'an unknown output argument must not be accepted');
    assert.strictEqual(r.err.code, 'OUTPUT_DATA_VALIDATION_FAIL');
    assert.strictEqual(r.data.fault.reason, 'unexpected output argument: surprise');
  });

  it('rejects the unknown key rather than crashing on it', () => {
    // The pre-5.0.0 code dereferenced argList[key].relatedStateVariable for
    // every key in args, so an unknown key threw a TypeError out of a function
    // whose callers do not catch. That is what this replaces.
    assert.doesNotThrow(() => { validate({input: {v: 'x'}, surprise: 1}, true); });
  });

  it('still reports a non-object return value as a missing output argument', () => {
    // a number/string/function return is a different mistake and keeps its own
    // (pre-existing) diagnosis rather than being reported as a stray key
    [123, 'str', function() {}].forEach((v) => {
      const r = validate(v, false);
      assert.ok(r.err != null);
      assert.strictEqual(r.err.code, 'OUTPUT_DATA_VALIDATION_FAIL');
      assert.strictEqual(r.data.fault.reason, 'output argument not found');
    });
  });

  it('still validates the declared argument against its schema', () => {
    const r = validate({input: {v: 42}}, true);   // v must be a string
    assert.ok(r.err != null);
    assert.strictEqual(r.err.code, 'INPUT_DATA_VALIDATION_FAIL');
    assert.strictEqual(r.data.fault.reason, 'data validation failed');
  });
});
