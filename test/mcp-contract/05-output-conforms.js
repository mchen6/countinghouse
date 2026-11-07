// tasks/result checks a stored output against the module's current schema on
// every read (lib/mcp/output-conforms.js). It uses the runtime's shared ajv
// instance, and ajv keeps every schema object it compiles, keyed by the
// object: since each read resolves a fresh schema object, a check that left
// its schema behind would grow that main-thread instance by one compiled
// validator per read -- driven by any caller polling a task -- and a schema
// carrying an $id would throw "already exists" from the second read on.
const assert = require('assert');
const validator = require('../../lib/validator');
const {outputConforms} = require('../../lib/mcp/output-conforms');

const freshSchema = () => ({type: 'object', properties: {text: {type: 'string'}}, required: ['text'], additionalProperties: false});

describe('mcp-contract 05: the stored-output conformance check', () => {
  it('answers like the runtime would', () => {
    assert.strictEqual(outputConforms(freshSchema(), {text: 'v1'}), true);
    assert.strictEqual(outputConforms(freshSchema(), {upper: 'V2'}), false);
  });

  it('leaves the shared ajv instance as it found it, however often it runs', () => {
    const ajv = validator.getSchemaValidator();
    const before = ajv._cache.size;
    for (let i = 0; i < 50; i++) outputConforms(freshSchema(), {text: 'v1'});
    assert.strictEqual(ajv._cache.size, before);
  });

  // A failed compile ("already exists") means the $id is someone else's
  // registration -- in single-thread mode the runtime compiles module schemas
  // on this same instance (lib/service.js) -- and must be left in place.
  it('leaves a schema another part of the runtime registered under the same $id', () => {
    const ajv = validator.getSchemaValidator();
    const id = 'https://countinghouse.test/registered-elsewhere.json';
    ajv.compile(Object.assign({$id: id}, freshSchema()));
    outputConforms(Object.assign({$id: id}, freshSchema()), {text: 'v1'});
    assert.notStrictEqual(ajv.getSchema(id), undefined);
    ajv.removeSchema(id);
  });

  it('gives the same answer every time for a schema with an $id', () => {
    const withId = () => Object.assign({$id: 'https://countinghouse.test/output-conforms.json'}, freshSchema());
    assert.deepStrictEqual([1, 2, 3].map(() => outputConforms(withId(), {text: 'v1'})), [true, true, true]);
  });
});
