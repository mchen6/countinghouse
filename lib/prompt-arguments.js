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

// A string argument's completion candidates (M11, spec section 7: its enum,
// then its examples), as the load derives them: each a string of at most
// MAX_CANDIDATE_CHARS, once, at most MAX_CANDIDATES per argument. Declared
// text, reviewed at install; never module code.
const MAX_CANDIDATES = 1000;
const MAX_CANDIDATE_CHARS = 256;
// and at most this many over all of a module's prompts, kept on the main
// thread for the module's life: past it, later arguments (in declaration
// order) offer none
const MAX_MODULE_CANDIDATES = 10000;
function candidatesOf(property, budget = MAX_CANDIDATES) {
  if (!isObject(property) || budget <= 0) return [];
  const out = [];
  const seen = new Set();
  for (const list of [property.enum, property.examples]) {
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      if (typeof(v) !== 'string' || v.length > MAX_CANDIDATE_CHARS || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= Math.min(MAX_CANDIDATES, budget)) return out;
    }
  }
  return out;
}

// -> Promise of Map(name -> {arguments: [{name, description?, required}] | null,
// validate: compiled ajv function | null, candidates: {argument: [string]}}).
// A prompt that declares no
// arguments takes none. Rejects with a message naming the prompt when a
// declared schema cannot be resolved or compiled: the load is refused.
async function deriveAll(device) {
  const out = new Map();
  let budget = MAX_MODULE_CANDIDATES;
  for (const p of promptsOf(device.spec)) {
    if (!(isObject(p.arguments) && typeof(p.arguments.schema) === 'string')) {
      out.set(p.name, {arguments: null, validate: null, candidates: Object.create(null)});
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
    // no prototype: an argument named __proto__ is a key like any other
    const candidates = Object.create(null);
    for (const name of Object.keys(properties)) {
      candidates[name] = candidatesOf(properties[name], budget);
      budget -= candidates[name].length;
    }
    out.set(p.name, {arguments: args, validate, candidates});
  }
  return out;
}

// A module's resource templates' completion candidates (M11, spec section
// 7: "the candidates come from the input schema property behind the
// variable"), derived at load as a prompt's are: {"<serviceID>|<action>":
// {variable: [string]}}, each variable's input property's enum, then its
// examples, bounded as a prompt argument's, within one module-wide budget.
// A template without variables (a static resource) has none. -> Promise;
// rejects naming the action when its input schema cannot be resolved.
async function deriveResources(device) {
  const {templateOf} = require('./declarations');
  const out = Object.create(null);
  let budget = MAX_MODULE_CANDIDATES;
  const services = isObject(device.spec) && isObject(device.spec.device) && isObject(device.spec.device.serviceList) ? device.spec.device.serviceList : {};
  for (const serviceID of Object.keys(services)) {
    const actions = isObject(services[serviceID]) && Array.isArray(services[serviceID].actionList) ? services[serviceID].actionList : [];
    for (const action of actions) {
      if (!isObject(action) || typeof(action.name) !== 'string' || !isObject(action.resource) || typeof(action.resource.uriTemplate) !== 'string') continue;
      const parsed = templateOf(action.resource.uriTemplate);
      if (parsed.error != null) continue;
      const variables = parsed.segments.map((p) => p.variable).filter((v) => v != null);
      if (variables.length === 0) continue;
      let properties = {};
      if (isObject(action.input) && typeof(action.input.schema) === 'string') {
        let schema;
        try {
          schema = JSON.parse(JSON.stringify(await resolve(device, action.input.schema)));
        } catch (e) {
          throw new Error(`resource ${action.name}: its input schema ${action.input.schema} could not be resolved (${e != null && e.message != null ? String(e.message).slice(0, 200) : 'error'})`);
        }
        if (isObject(schema) && isObject(schema.properties)) properties = schema.properties;
      }
      const candidates = Object.create(null);
      for (const v of variables) {
        candidates[v] = candidatesOf(Object.prototype.hasOwnProperty.call(properties, v) ? properties[v] : null, budget);
        budget -= candidates[v].length;
      }
      out[`${serviceID}|${action.name}`] = candidates;
    }
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

// What completion/complete offers for each prompt's arguments (M11):
// {name: {argument: [string]}}
function completions(derived) {
  const out = Object.create(null);
  for (const [name, d] of derived) out[name] = d.candidates != null ? d.candidates : Object.create(null);
  return out;
}

// -> null when `args` passes the prompt's schema, else up to MAX_ERRORS
// [{instancePath, message}]. A prompt with no schema takes any object.
function check(entry, args) {
  if (entry == null || typeof(entry.validate) !== 'function') return null;
  if (entry.validate(args) === true) return null;
  return (entry.validate.errors || []).slice(0, MAX_ERRORS).map((e) => ({instancePath: String(e.instancePath || '').slice(0, 200), message: String(e.message || '').slice(0, 200)}));
}

module.exports = {deriveAll, deriveResources, listed, completions, check, promptsOf, candidatesOf, MAX_ERRORS, MAX_CANDIDATES, MAX_CANDIDATE_CHARS, MAX_MODULE_CANDIDATES};
