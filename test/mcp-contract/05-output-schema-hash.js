// The fingerprint tasks/result compares: the output schema a task's result
// was produced under (stamped at completion) against the one advertised now.
// Two schemas that differ only in key order are the same schema, so they
// must hash the same; any real difference must not.
const assert = require('assert');
const {canonicalJSON, outputSchemaHash} = require('../../lib/mcp/output-schema-hash');

describe('mcp-contract 05: output schema hash', () => {
  it('canonicalJSON sorts object keys at every depth and keeps array order', () => {
    const a = {type: 'object', properties: {b: {type: 'string'}, a: {type: 'number', enum: [2, 1]}}, required: ['b', 'a']};
    const b = {required: ['b', 'a'], properties: {a: {enum: [2, 1], type: 'number'}, b: {type: 'string'}}, type: 'object'};
    assert.strictEqual(canonicalJSON(a), canonicalJSON(b));
    assert.strictEqual(canonicalJSON(a),
      '{"properties":{"a":{"enum":[2,1],"type":"number"},"b":{"type":"string"}},"required":["b","a"],"type":"object"}');
    assert.notStrictEqual(canonicalJSON({required: ['a', 'b']}), canonicalJSON({required: ['b', 'a']}));
  });

  it('outputSchemaHash is a sha256 hex of the canonical form, null for no schema', () => {
    const h = outputSchemaHash({type: 'object', properties: {text: {type: 'string'}}});
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.strictEqual(outputSchemaHash({properties: {text: {type: 'string'}}, type: 'object'}), h);
    assert.notStrictEqual(outputSchemaHash({type: 'object', properties: {text: {type: 'string'}, n: {type: 'number'}}}), h);
    assert.strictEqual(outputSchemaHash(null), null);
    assert.strictEqual(outputSchemaHash(undefined), null);
  });
});
