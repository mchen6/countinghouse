// MCP completeness M4, spec section 1: the advertised output schema. Each
// binary field whose media type makes a block (image/* or audio/*; any other
// waits for M6's resource blocks and links, the reviewer's ruling) is
// replaced by the reference shape, keeping its title and description. With
// none, the module's own schema object is advertised unchanged. tools/list,
// tools/call and a task's schema hash all derive from this one function.
const assert = require('assert');
const {advertisedSchema, blockFields, REFERENCE_SHAPE} = require('../../lib/binary-fields');
const {outputSchemaHash} = require('../../lib/mcp/output-schema-hash');

const bin = (mediaType, extra = {}) => Object.assign({type: 'string', contentEncoding: 'base64', contentMediaType: mediaType}, extra);

describe('validation 21: the advertised output schema (M4)', () => {
  const schema = {type: 'object', required: ['caption'], properties: {
    caption: {type: 'string'},
    chart: bin('image/png', {title: 'Chart', description: 'The rendered chart'}),
    clips: {type: 'array', items: bin('audio/wav')},
    doc: bin('application/pdf', {description: 'stays base64 until M6'})
  }};

  it('the reference shape is the spec\'s', () => {
    assert.deepStrictEqual(REFERENCE_SHAPE, {type: 'object', additionalProperties: false, required: ['mimeType', 'bytes'],
      properties: {mimeType: {type: 'string'}, bytes: {type: 'integer', minimum: 0}, block: {type: 'integer', minimum: 0}, uri: {type: 'string'}}});
  });

  it('image and audio fields become the reference shape, keeping title and description; any other stays as declared', () => {
    const a = advertisedSchema(schema);
    assert.deepStrictEqual(a.properties.chart, Object.assign({title: 'Chart', description: 'The rendered chart'}, REFERENCE_SHAPE));
    assert.deepStrictEqual(a.properties.clips, {type: 'array', items: REFERENCE_SHAPE});
    assert.deepStrictEqual(a.properties.doc, schema.properties.doc);
    assert.deepStrictEqual(a.properties.caption, schema.properties.caption);
    assert.deepStrictEqual(a.required, ['caption']);
  });

  it('leaves the module\'s schema untouched (the validator checks against it)', () => {
    const before = JSON.stringify(schema);
    advertisedSchema(schema);
    assert.strictEqual(JSON.stringify(schema), before);
  });

  it('a schema with no block fields is advertised as the same object', () => {
    const plain = {type: 'object', properties: {doc: bin('application/pdf'), n: {type: 'integer'}}};
    assert.strictEqual(advertisedSchema(plain), plain);
    assert.strictEqual(advertisedSchema(null), null);
  });

  it('a property named __proto__ is copied as data, never as the prototype', () => {
    const {reshape} = require('../../lib/binary-fields');
    const s = JSON.parse('{"type": "object", "properties": {"__proto__": {"type": "string", "contentEncoding": "base64", "contentMediaType": "image/png"}}}');
    const a = advertisedSchema(s);
    assert.ok(Object.hasOwn(a.properties, '__proto__'));
    assert.strictEqual(a.properties.__proto__.type, 'object');
    const out = reshape(JSON.parse('{"__proto__": "AA=="}'), s, {module: 'm', action: 'a'});
    assert.ok(Object.hasOwn(out.structured, '__proto__'));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(out.structured)), JSON.parse('{"__proto__": {"mimeType": "image/png", "bytes": 1, "block": 1}}'));
  });

  it('is computed once per schema object', () => {
    assert.strictEqual(advertisedSchema(schema), advertisedSchema(schema));
  });

  it('blockFields: the image and audio fields only, in schema order', () => {
    assert.deepStrictEqual(blockFields(schema), [{path: ['chart'], mediaType: 'image/png'}, {path: ['clips', '*'], mediaType: 'audio/wav'}]);
  });

  it('a task\'s schema hash is taken over the advertised schema; a schema with no block fields hashes as before', () => {
    const {createHash} = require('crypto');
    assert.strictEqual(outputSchemaHash(schema), outputSchemaHash(advertisedSchema(schema)));
    assert.notStrictEqual(outputSchemaHash(schema), createHash('sha256').update(require('../../lib/mcp/output-schema-hash').canonicalJSON(schema)).digest('hex'));
    const plain = {type: 'object', properties: {n: {type: 'integer'}}};
    assert.strictEqual(outputSchemaHash(plain), createHash('sha256').update(require('../../lib/mcp/output-schema-hash').canonicalJSON(plain)).digest('hex'));
  });
});
