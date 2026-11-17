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

// The walk that finds a schema's binary fields: found(node, path) for each,
// in schema order. '*' in a path is an array's every item; a whole output
// that is binary is the path [].
function eachBinary(schema, found) {
  const seen = new Set();
  const walk = (s, path) => {
    if (!isObject(s) || seen.has(s)) return;
    if (isBinary(s)) {
      found(s, path);
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
}

// schema -> [{path: [key | '*'], mediaType}], in schema order.
function binaryFields(schema) {
  const out = [];
  eachBinary(schema, (s, path) => out.push({path, mediaType: s.contentMediaType}));
  return out;
}

// schema -> the schema nodes binaryFields maps, in the same order: what a
// load-time check holds a declaration against (lib/declarations.js).
function binaryNodes(schema) {
  const out = [];
  eachBinary(schema, (s) => out.push(s));
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

// --- M4: content blocks (spec section 1) -----------------------------------
//
// Every binary value is sent as a block of its own, and structuredContent
// (and so the text block, its JSON) holds a reference to it instead of the
// base64: image/* and audio/* as their blocks, any other media type as a
// resource block, and a value past the inline budget as a resource link
// (M6, lib/mcp/result-content.js, which places them).
const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v != null && typeof(v) === 'object') deepFreeze(v); }); return Object.freeze(o); };
const REFERENCE_SHAPE = deepFreeze({type: 'object', additionalProperties: false, required: ['mimeType', 'bytes'],
  properties: {mimeType: {type: 'string'}, bytes: {type: 'integer', minimum: 0}, block: {type: 'integer', minimum: 0}, uri: {type: 'string'}}});

// schema -> the binary fields that become blocks (every one, since M6),
// computed once per schema object (a reload replaces the object).
const blockCache = new WeakMap();
function blockFields(schema) {
  if (schema == null || typeof(schema) !== 'object') return [];
  if (!blockCache.has(schema)) blockCache.set(schema, binaryFields(schema));
  return blockCache.get(schema);
}

// The schema advertised for an output (tools/list, tools/call, a task's
// schema hash: one function): each block field replaced by REFERENCE_SHAPE,
// keeping its title and description; the module's schema object itself when
// it has none. Copy on write along each field's path; the module's schema,
// which the validator checks against, is never changed.
const advertisedCache = new WeakMap();
function advertisedSchema(schema) {
  if (schema == null || typeof(schema) !== 'object') return schema;
  if (advertisedCache.has(schema)) return advertisedCache.get(schema);
  const fields = blockFields(schema);
  let out = schema;
  const rebuild = (s, path) => {
    if (path.length === 0) {
      const kept = {};
      for (const k of ['title', 'description']) if (typeof(s[k]) === 'string') kept[k] = s[k];
      return Object.assign(kept, REFERENCE_SHAPE);
    }
    const [step, ...rest] = path;
    // spread and defineProperty (no [[Set]]): a key named __proto__ stays data
    if (step === '*') return {...s, items: rebuild(s.items, rest)};
    const properties = {...s.properties};
    Object.defineProperty(properties, step, {value: rebuild(s.properties[step], rest), enumerable: true, writable: true, configurable: true});
    return {...s, properties};
  };
  for (const f of fields) out = rebuild(out, f.path);
  advertisedCache.set(schema, out);
  return out;
}

// The decoded length of base64, without decoding it.
const decodedLength = (b64) => Buffer.byteLength(b64, 'base64');

// An RFC 6901 pointer's segments (escapePointer's inverse).
const pointerSegments = (pointer) => (pointer === '' ? [] : pointer.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')));

// value with the node at `pointer` replaced by `replacement`: copy on write
// along the pointer's path only, so a large output is not cloned, and the
// given value is never changed.
function replaceAt(value, pointer, replacement) {
  const segs = pointerSegments(pointer);
  const set = (node, i) => {
    if (i === segs.length) return replacement;
    // spread and defineProperty (no [[Set]]): a key named __proto__ stays data
    const copy = Array.isArray(node) ? node.slice() : {...node};
    Object.defineProperty(copy, segs[i], {value: set(node[segs[i]], i + 1), enumerable: true, writable: true, configurable: true});
    return copy;
  };
  return set(value, 0);
}

module.exports = {binaryFields, binaryNodes, binaryValues, isBinary, blockFields, advertisedSchema, replaceAt, decodedLength, REFERENCE_SHAPE,
  MAX_DEPTH, MAX_BINARY_FIELDS, MAX_BINARY_VALUES};
