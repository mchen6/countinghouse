// MCP completeness M3, spec section 1: the binary-field map. A field is
// binary when its schema is {type: "string", contentEncoding: "base64",
// contentMediaType}. The map is found by walking an output schema from its
// root through `properties` and array `items` only, at most 8 levels deep,
// and never through $ref (the reviewer's ruling: a binary field reached only
// through a $ref counts as "elsewhere", which countinghouse-validate and the
// load refuse). binaryValues reads a result's binary values by that map, an
// array counting each item; more than 16 is TOO_MANY_BINARY_VALUES.
const assert = require('assert');
const {binaryFields, binaryValues, MAX_BINARY_FIELDS, MAX_BINARY_VALUES, MAX_DEPTH} = require('../../lib/binary-fields');

const bin = (mediaType, extra = {}) => Object.assign({type: 'string', contentEncoding: 'base64', contentMediaType: mediaType}, extra);

describe('validation 18: the binary-field map', () => {
  it('the bounds are the spec\'s: 16 fields, 16 values, 8 levels', () => {
    assert.deepStrictEqual([MAX_BINARY_FIELDS, MAX_BINARY_VALUES, MAX_DEPTH], [16, 16, 8]);
  });

  it('finds fields through properties and items, in schema order', () => {
    const schema = {type: 'object', properties: {
      title: {type: 'string'},
      chart: bin('image/png'),
      pages: {type: 'array', items: {type: 'object', properties: {scan: bin('image/jpeg'), text: {type: 'string'}}}},
      clips: {type: 'array', items: bin('audio/wav')}
    }};
    assert.deepStrictEqual(binaryFields(schema), [
      {path: ['chart'], mediaType: 'image/png'},
      {path: ['pages', '*', 'scan'], mediaType: 'image/jpeg'},
      {path: ['clips', '*'], mediaType: 'audio/wav'}
    ]);
  });

  it('a whole output that is binary is the root path', () => {
    assert.deepStrictEqual(binaryFields(bin('application/pdf')), [{path: [], mediaType: 'application/pdf'}]);
  });

  it('is not binary without all three keywords, or with another encoding', () => {
    const schema = {type: 'object', properties: {
      a: {type: 'string', contentEncoding: 'base64'},
      b: {type: 'string', contentMediaType: 'image/png'},
      c: {contentEncoding: 'base64', contentMediaType: 'image/png'},
      d: {type: 'string', contentEncoding: 'base32', contentMediaType: 'image/png'},
      e: {type: ['string', 'null'], contentEncoding: 'base64', contentMediaType: 'image/png'}
    }};
    assert.deepStrictEqual(binaryFields(schema), []);
  });

  it('does not look under $ref, oneOf, anyOf, allOf, if, patternProperties, additionalProperties or prefixItems', () => {
    const b = bin('image/png');
    const schema = {type: 'object', $defs: {img: b}, properties: {
      r: {$ref: '#/$defs/img'},
      o: {oneOf: [b]}, n: {anyOf: [b]}, l: {allOf: [b]}, i: {if: b, then: b},
      p: {type: 'object', patternProperties: {'^x': b}},
      x: {type: 'object', additionalProperties: b},
      t: {type: 'array', prefixItems: [b]}
    }};
    assert.deepStrictEqual(binaryFields(schema), []);
  });

  it('finds a field 8 levels down, not 9', () => {
    const nest = (n, leaf) => (n === 0 ? leaf : {type: 'object', properties: {k: nest(n - 1, leaf)}});
    assert.deepStrictEqual(binaryFields(nest(8, bin('image/png'))), [{path: Array(8).fill('k'), mediaType: 'image/png'}]);
    assert.deepStrictEqual(binaryFields(nest(9, bin('image/png'))), []);
  });

  it('returns every declared field, so a check can count them against MAX_BINARY_FIELDS', () => {
    const properties = {};
    for (let i = 0; i < 17; i++) properties[`f${i}`] = bin('image/png');
    assert.strictEqual(binaryFields({type: 'object', properties}).length, 17);
  });

  it('is safe on anything: no schema, a non-object, a cycle by identity', () => {
    assert.deepStrictEqual(binaryFields(null), []);
    assert.deepStrictEqual(binaryFields(true), []);
    const loop = {type: 'object', properties: {}};
    loop.properties.self = loop;
    assert.ok(Array.isArray(binaryFields(loop)));
  });

  describe('binaryValues', () => {
    const fields = [{path: ['chart'], mediaType: 'image/png'}, {path: ['pages', '*', 'scan'], mediaType: 'image/jpeg'}];
    it('reads each value by the map, with its JSON pointer, an array item each', () => {
      const out = {chart: 'AA==', pages: [{scan: 'AQ=='}, {text: 'no scan'}, {scan: 'Ag=='}]};
      assert.deepStrictEqual(binaryValues(fields, out, {module: 'm', action: 'a'}), [
        {pointer: '/chart', mediaType: 'image/png', value: 'AA=='},
        {pointer: '/pages/0/scan', mediaType: 'image/jpeg', value: 'AQ=='},
        {pointer: '/pages/2/scan', mediaType: 'image/jpeg', value: 'Ag=='}
      ]);
    });
    it('a whole binary output is the root pointer', () => {
      assert.deepStrictEqual(binaryValues([{path: [], mediaType: 'application/pdf'}], 'JVBE', {module: 'm', action: 'a'}),
        [{pointer: '', mediaType: 'application/pdf', value: 'JVBE'}]);
    });
    it('escapes a pointer as RFC 6901 does', () => {
      assert.deepStrictEqual(binaryValues([{path: ['a/b~c'], mediaType: 'image/png'}], {'a/b~c': 'AA=='}, {module: 'm', action: 'a'}),
        [{pointer: '/a~1b~0c', mediaType: 'image/png', value: 'AA=='}]);
    });
    it('skips what is absent or not a string', () => {
      assert.deepStrictEqual(binaryValues(fields, {pages: 'not an array'}, {module: 'm', action: 'a'}), []);
      assert.deepStrictEqual(binaryValues(fields, null, {module: 'm', action: 'a'}), []);
    });
    it('16 values pass; 17 are TOO_MANY_BINARY_VALUES, naming the module and action', () => {
      const f = [{path: ['clips', '*'], mediaType: 'audio/wav'}];
      assert.strictEqual(binaryValues(f, {clips: Array(16).fill('AA==')}, {module: 'm', action: 'a'}).length, 16);
      assert.throws(() => binaryValues(f, {clips: Array(17).fill('AA==')}, {module: 'm', action: 'a'}), (e) => {
        assert.strictEqual(e.code, 'TOO_MANY_BINARY_VALUES');
        assert.match(e.message, /m\/a/);
        assert.match(e.message, /more than 16/);
        return true;
      });
    });
  });
});
