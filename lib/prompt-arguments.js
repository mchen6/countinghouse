'use strict';
// A prompt's arguments (MCP completeness M10, spec section 7): derived from
// the object schema its declaration points to (`arguments: {schema}` in
// schema.json), and checked against it. Run only where a module's schemas
// may be walked and compiled: in a validator (lib/validator-worker.js), or
// on the main thread in single-thread mode, which compiles there already.
// The main thread of a worker-mode runtime never walks a module's schema
// (the lean worker): it keeps what a validator derived at load
// (lib/module-spec.js prompts), and asks one to check each prompts/get.
//
// device: {spec, schemaDoc, resolveSchemaFromPath, schemaValidator?} -- a
// validator's device, or a single-thread CHDevice.
const validator = require('./validator');

// a check's messages: at most this many, each cut (the gateway cleans them
// as declared text: lib/schema-safety.js declaredText)
const MAX_ERRORS = 5;

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);

function promptsOf(spec) {
  const list = isObject(spec) && isObject(spec.device) && Array.isArray(spec.device.promptList) ? spec.device.promptList : [];
  return list.filter((p) => isObject(p) && typeof(p.name) === 'string');
}

// The schema a pointer names, dereferenced, as an action's is
// (CHDevice.prototype.resolveSchemaFromPath). -> Promise.
function resolve(device, pointer) {
  return new Promise((done, fail) => device.resolveSchemaFromPath.call(device, pointer, null, (err, _, data) => (err != null ? fail(err) : done(data))));
}

// -> Promise of Map(name -> {arguments: [{name, description?, required}] | null,
// validate: compiled ajv function | null}). A prompt that declares no
// arguments takes none. Rejects with a message naming the prompt when a
// declared schema cannot be resolved or compiled: the load is refused.
async function deriveAll(device) {
  const out = new Map();
  for (const p of promptsOf(device.spec)) {
    if (!(isObject(p.arguments) && typeof(p.arguments.schema) === 'string')) {
      out.set(p.name, {arguments: null, validate: null});
      continue;
    }
    let schema;
    try {
      schema = JSON.parse(JSON.stringify(await resolve(device, p.arguments.schema)));
    } catch (e) {
      throw new Error(`prompt ${p.name}: its arguments schema ${p.arguments.schema} could not be resolved (${e != null && e.message != null ? String(e.message).slice(0, 200) : 'error'})`);
    }
    let validate;
    try {
      const ajv = device.schemaValidator != null ? device.schemaValidator : validator.getSchemaValidator();
      validate = ajv.compile(schema);
    } catch (e) {
      throw new Error(`prompt ${p.name}: its arguments schema could not be compiled (${e != null && e.message != null ? String(e.message).slice(0, 200) : 'error'})`);
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const args = Object.keys(properties).map((name) => {
      const a = {name};
      if (isObject(properties[name]) && typeof(properties[name].description) === 'string') a.description = properties[name].description;
      a.required = required.includes(name);
      return a;
    });
    out.set(p.name, {arguments: args, validate});
  }
  return out;
}

// What prompts/list shows of each prompt's arguments: {name: [args] | null}
function listed(derived) {
  // no prototype: a prompt named __proto__ is a key like any other
  const out = Object.create(null);
  for (const [name, d] of derived) out[name] = d.arguments;
  return out;
}

// -> null when `args` passes the prompt's schema, else up to MAX_ERRORS
// [{instancePath, message}]. A prompt with no schema takes any object.
function check(entry, args) {
  if (entry == null || typeof(entry.validate) !== 'function') return null;
  if (entry.validate(args) === true) return null;
  return (entry.validate.errors || []).slice(0, MAX_ERRORS).map((e) => ({instancePath: String(e.instancePath || '').slice(0, 200), message: String(e.message || '').slice(0, 200)}));
}

module.exports = {deriveAll, listed, check, promptsOf, MAX_ERRORS};
