'use strict';
// The binary-field map (MCP completeness, spec section 1). An output field is
// binary when its schema is {type: "string", contentEncoding: "base64",
// contentMediaType: "<type>/<subtype>"}: the media type is fixed in the
// schema, so a module can't choose it per call.
//
// The map is found by walking a schema from its root through `properties`
// and array `items` only, at most MAX_DEPTH levels deep. Nothing else is
// followed, $ref included (the reviewer's ruling, 2026-11-15): a binary
// declaration reached any other way counts as "elsewhere", which
// countinghouse-validate and the load refuse, saying to declare the field
// inline. So the map is deterministic and needs no resolver. A schema can't
// declare more than MAX_BINARY_FIELDS (that check is countinghouse-validate's;
// binaryFields returns every field it finds, so it can count them), and one
// result can't hold more than MAX_BINARY_VALUES (binaryValues).
const {CountinghouseError} = require('./countinghouse-error');
const {escapePointer: escape} = require('./serialized-result');

const MAX_DEPTH = 8;
const MAX_BINARY_FIELDS = 16;
const MAX_BINARY_VALUES = 16;

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);

function isBinary(schema) {
  return isObject(schema) && schema.type === 'string' && schema.contentEncoding === 'base64' &&
    typeof(schema.contentMediaType) === 'string';
}

// schema -> [{path: [key | '*'], mediaType}], in schema order. '*' is an
// array's every item. A whole output that is binary is the path [].
function binaryFields(schema) {
  const out = [];
  const seen = new Set();
  const walk = (s, path) => {
    if (!isObject(s) || seen.has(s)) return;
    if (isBinary(s)) {
      out.push({path, mediaType: s.contentMediaType});
      return;
    }
    if (path.length >= MAX_DEPTH) return;
    seen.add(s);
    if (isObject(s.properties)) {
      for (const key of Object.keys(s.properties)) walk(s.properties[key], path.concat(key));
    }
    if (isObject(s.items)) walk(s.items, path.concat('*'));
    seen.delete(s);
  };
  walk(schema, []);
  return out;
}

// (fields, output, {module, action}) -> [{pointer, mediaType, value}]: each
// string value the map names, an array counting each item, with its RFC 6901
// pointer, in field order and then item order. What is absent or not a
// string is skipped (the validator has already checked the output against
// its schema). More than MAX_BINARY_VALUES is TOO_MANY_BINARY_VALUES.
function binaryValues(fields, output, {module, action} = {}) {
  const out = [];
  const read = (value, path, i, pointer, mediaType) => {
    if (i === path.length) {
      if (typeof(value) === 'string') {
        out.push({pointer, mediaType, value});
        if (out.length > MAX_BINARY_VALUES) {
          throw CountinghouseError.withFields('TOO_MANY_BINARY_VALUES', {module: String(module), action: String(action), max: MAX_BINARY_VALUES});
        }
      }
      return;
    }
    const step = path[i];
    if (step === '*') {
      if (!Array.isArray(value)) return;
      value.forEach((item, n) => read(item, path, i + 1, `${pointer}/${n}`, mediaType));
      return;
    }
    if (!isObject(value) || !Object.hasOwn(value, step)) return;
    read(value[step], path, i + 1, `${pointer}/${escape(step)}`, mediaType);
  };
  for (const f of fields) read(output, f.path, 0, '', f.mediaType);
  return out;
}

module.exports = {binaryFields, binaryValues, isBinary, MAX_DEPTH, MAX_BINARY_FIELDS, MAX_BINARY_VALUES};
