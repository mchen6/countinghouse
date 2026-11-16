'use strict';
// What a module declares for the MCP completeness layer (the design,
// docs/superpowers/specs/2026-11-15-mcp-completeness-design.md), checked
// where the meta-schema (spec/schema.json) cannot say it: rules that tie
// api.json to schema.json, and rules about where in a schema a thing may
// sit.
//
//   check(spec, schemaDoc) -> {problems: [{path, message}], warnings: [...]}
//
// spec is api.json, parsed; schemaDoc is schema.json, parsed (or null).
// countinghouse-validate reports every problem (lib/module-validator.js);
// the load refuses a module for the first (lib/validator-worker.js, with the
// schema-safety check, off the main thread), and is the one that decides.
//
// Pure and bounded: no file is read and no schema compiled. A walk visits
// each node of schema.json at most once (by identity), so a loop of $refs
// ends, and schema.json is bounded before this runs (lib/schema-safety.js).
// It is tolerant of a spec the meta-schema would refuse: a value of the
// wrong shape is "not declared here", and the meta-schema's own check says
// what is wrong with it.
const binary = require('./binary-fields');

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// urn:countinghouse-com:serviceID:echoService -> echoService, as the
// handlers/ directory names a service (lib/handler-map.js)
const shortNameOf = (serviceID) => { const i = String(serviceID).indexOf(':serviceID:'); return i === -1 ? String(serviceID) : String(serviceID).slice(i + ':serviceID:'.length); };

// Keywords whose value is data, never a subschema: a look-alike inside one
// is not a declaration.
const DATA = new Set(['default', 'examples', 'enum', 'const']);
// Keywords whose value maps a NAME to a subschema: the names are the
// author's (a property may be called "default" or "oneOf"), never keywords.
const MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const MAX_REF_HOPS = 16;
// <type>/<subtype>, RFC 6838's restricted names, no parameters
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

// The node an RFC 6901 pointer names in `doc` ("/service/action/input", as
// api.json writes one), or undefined.
function at(doc, pointer) {
  if (typeof(pointer) !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) return undefined;
  let node = doc;
  if (pointer === '') return node;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || typeof(node) !== 'object' || !own(node, token)) return undefined;
    node = node[token];
  }
  return node;
}

// The node a local $ref names ('#', '#/a/b'), or undefined: only this
// document's own places are followed.
function refTarget(doc, ref) {
  if (typeof(ref) !== 'string' || !ref.startsWith('#')) return undefined;
  let pointer = ref.slice(1);
  try { pointer = decodeURI(pointer); } catch (e) { return undefined; }
  return at(doc, pointer);
}

// `node`, or what a chain of local $refs at its root ends at (a schema that
// is only a pointer elsewhere), within MAX_REF_HOPS.
function deref(doc, node) {
  let n = node;
  for (let hops = 0; hops < MAX_REF_HOPS && isObject(n) && typeof(n.$ref) === 'string' && Object.keys(n).length === 1; hops++) {
    const next = refTarget(doc, n.$ref);
    if (next === undefined) return n;
    n = next;
  }
  return n;
}

// Every schema node under `root`, each once: visit(node, trail, keywords).
// trail is how it was reached, for a message (keywords and names, as a
// pointer's tokens; '$ref' for a reference followed); keywords is the
// keywords alone, in order. A schema's own keys are keywords: a data
// keyword's value is not entered, a map keyword's value is entered by its
// names, anything else that holds objects is entered as subschemas (an
// unknown keyword's too: what the gateway does not walk is "elsewhere").
function walkAll(doc, root, visit) {
  const seen = new Set();
  const schema = (node, trail, keywords) => {
    if (!isObject(node) || seen.has(node)) return;
    seen.add(node);
    visit(node, trail, keywords);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (DATA.has(key)) continue;
      if (key === '$ref' || key === '$dynamicRef') {
        const target = refTarget(doc, value);
        if (target !== undefined) schema(target, trail.concat('$ref'), keywords.concat('$ref'));
      } else if (MAPS.has(key)) {
        if (isObject(value)) for (const name of Object.keys(value)) schema(value[name], trail.concat(key, name), keywords.concat(key));
      } else if (Array.isArray(value)) {
        value.forEach((item, i) => schema(item, trail.concat(key, String(i)), keywords.concat(key)));
      } else {
        schema(value, trail.concat(key), keywords.concat(key));
      }
    }
  };
  schema(root, [], []);
}

// {serviceID, service, action, name: 'service.action'} for each action
function actionsOf(spec) {
  const out = [];
  const list = isObject(spec) && isObject(spec.device) && isObject(spec.device.serviceList) ? spec.device.serviceList : {};
  for (const serviceID of Object.keys(list)) {
    const actions = isObject(list[serviceID]) && Array.isArray(list[serviceID].actionList) ? list[serviceID].actionList : [];
    for (const action of actions) {
      if (!isObject(action) || typeof(action.name) !== 'string') continue;
      out.push({serviceID: serviceID, service: shortNameOf(serviceID), action: action, name: `${shortNameOf(serviceID)}.${action.name}`});
    }
  }
  return out;
}

// the schema an action's input / output / fault pointer names, or undefined
function schemaOf(schemaDoc, action, which) {
  const p = isObject(action[which]) ? action[which].schema : undefined;
  return (schemaDoc == null || typeof(p) !== 'string') ? undefined : at(schemaDoc, p);
}

// ---- section 1: binary output fields ------------------------------------

// a node that claims to be binary: base64 with a media type, whatever its type
const claimsBinary = (node) => isObject(node) && node.contentEncoding === 'base64' && own(node, 'contentMediaType');

function binaryProblems(schemaDoc, entry, problems) {
  const output = schemaOf(schemaDoc, entry.action, 'output');
  if (output === undefined) return;
  const where = `${entry.name} output`;
  // the map the gateway will use: properties and items only, 8 levels, no $ref
  const fields = binary.binaryFields(output);
  const mapped = new Set();
  const collect = (node, depth) => {
    if (!isObject(node)) return;
    if (binary.isBinary(node)) { mapped.add(node); return; }
    if (depth >= binary.MAX_DEPTH) return;
    if (isObject(node.properties)) for (const key of Object.keys(node.properties)) collect(node.properties[key], depth + 1);
    if (isObject(node.items)) collect(node.items, depth + 1);
  };
  collect(output, 0);
  if (fields.length > binary.MAX_BINARY_FIELDS) {
    problems.push({path: where, message: `${where} declares ${fields.length} binary fields; an action may declare at most ${binary.MAX_BINARY_FIELDS}`});
  }
  // every other declaration under the output, by whatever way it is reached
  walkAll(schemaDoc, output, (node, trail, keywords) => {
    if (!claimsBinary(node) || mapped.has(node)) return;
    const reached = trail.length === 0 ? 'the output itself' : `/${trail.join('/')}`;
    if (node.type !== 'string') {
      problems.push({path: where, message: `${where} ${reached}: a binary field's type is exactly "string" (no union type); declare it inline, under properties or items`});
      return;
    }
    const other = keywords.find((k) => k !== 'properties' && k !== 'items');
    const why = keywords.includes('$ref') ? 'is reached through a $ref, which the gateway does not follow'
      : other === undefined ? `is deeper than ${binary.MAX_DEPTH} levels`
        : `is under ${other}`;
    problems.push({path: where, message: `${where} ${reached}: this binary field ${why}; declare it inline, under properties or items, at most ${binary.MAX_DEPTH} levels deep`});
  });
  for (const f of fields) {
    if (typeof(f.mediaType) !== 'string' || !MEDIA_TYPE.test(f.mediaType)) {
      problems.push({path: where, message: `${where} /${f.path.join('/')}: contentMediaType ${JSON.stringify(String(f.mediaType).slice(0, 80))} is not a media type of the form type/subtype`});
    }
  }
}

// ---- section 4: x-mcp-header ---------------------------------------------

function headerProblems(schemaDoc, entry, problems) {
  const input = schemaOf(schemaDoc, entry.action, 'input');
  if (input === undefined) return;
  const where = `${entry.name} input`;
  let found = null;
  walkAll(schemaDoc, input, (node, trail) => {
    if (found == null && own(node, 'x-mcp-header')) found = trail;
  });
  if (found != null) {
    problems.push({path: where, message: `${where} ${found.length === 0 ? '' : `/${found.join('/')} `}declares x-mcp-header: x-mcp-header is not served by this runtime (the server's side of it is not designed), so a schema may not carry it`.replace(/ {2,}/g, ' ')});
  }
}

// ---- shared by sections 3, 7 and 8 ---------------------------------------

// `node` read as an object schema (through a root that is only a $ref):
// {properties, required}, or null when it is not one
function objectSchema(doc, node) {
  const n = deref(doc, node);
  if (!isObject(n) || n.type !== 'object' || (own(n, 'properties') && !isObject(n.properties))) return null;
  return {node: n, properties: isObject(n.properties) ? n.properties : {}, required: Array.isArray(n.required) ? n.required.filter((r) => typeof(r) === 'string') : []};
}
const isString = (p) => isObject(p) && p.type === 'string';

// ---- section 3: resources --------------------------------------------------

const MAX_VARIABLES = 8;
// a segment: unreserved characters and {name} variables (RFC 6570 level 1,
// the subset this layer takes: no operator, no modifier, no percent-escape,
// nothing a URI gives another meaning)
const SEGMENT = /^(?:[A-Za-z0-9._~-]|\{[A-Za-z_][A-Za-z0-9_]{0,63}\})+$/;
const VARIABLE = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;

// -> {variables, shape} (shape: the template with each variable as {}, what
// two templates that match the same URIs share), or {error}
function templateOf(template) {
  if (typeof(template) !== 'string' || template === '') return {error: 'it is empty'};
  const segments = template.split('/');
  for (const seg of segments) {
    if (seg === '') return {error: 'it has an empty segment (a leading, trailing or doubled /)'};
    if (seg === '.' || seg === '..') return {error: 'it has a . or .. segment'};
    if (!SEGMENT.test(seg)) return {error: `its segment ${JSON.stringify(seg.slice(0, 40))} is not letters, digits, . _ ~ - and {name} variables`};
  }
  const variables = [...template.matchAll(VARIABLE)].map((m) => m[1]);
  const twice = variables.find((v, i) => variables.indexOf(v) !== i);
  if (twice !== undefined) return {error: `it names {${twice}} twice`};
  if (variables.length > MAX_VARIABLES) return {error: `it has ${variables.length} variables; a template has at most ${MAX_VARIABLES} variables`};
  return {variables: variables, shape: template.replace(VARIABLE, '{}')};
}

function resourceProblems(doc, entry, names, completions, problems) {
  const r = entry.action.resource;
  if (!isObject(r) || typeof(r.uriTemplate) !== 'string') return null;
  const where = `${entry.name} resource`;
  const parsed = templateOf(r.uriTemplate);
  if (parsed.error != null) {
    problems.push({path: where, message: `${where}: uriTemplate ${JSON.stringify(r.uriTemplate.slice(0, 80))} is not a relative path of literals and {name} variables: ${parsed.error}`});
    return null;
  }
  if (entry.action.longRunning === true) {
    problems.push({path: where, message: `${where}: a resource is read in one answer: longRunning may not be declared on a resource action`});
  }
  // each variable is a string property of the input, and every required
  // input is a variable (a read could never give another)
  const input = schemaOf(doc, entry.action, 'input');
  const schema = input === undefined ? {properties: {}, required: []} : objectSchema(doc, input);
  if (schema == null) {
    problems.push({path: where, message: `${where}: the action's input is not an object schema, so its variables have nothing to become`});
  } else {
    for (const v of parsed.variables) {
      if (!own(schema.properties, v)) problems.push({path: where, message: `${where}: its variable {${v}} is not a property of its input schema`});
      else if (!isString(schema.properties[v])) problems.push({path: where, message: `${where}: its variable {${v}} is an input property that is not of type "string"`});
    }
    for (const req of schema.required) {
      if (!parsed.variables.includes(req)) problems.push({path: where, message: `${where}: the required input "${req}" is not a variable of its uriTemplate, so no read could give it`});
    }
  }
  if (Array.isArray(r.changesWith)) {
    for (const ref of r.changesWith) {
      if (typeof(ref) === 'string' && !names.has(ref)) problems.push({path: where, message: `${where}: changesWith names ${ref}, which is no action of this module`});
    }
  }
  if (isObject(r.completion)) {
    for (const arg of Object.keys(r.completion)) {
      const ref = r.completion[arg];
      if (!parsed.variables.includes(arg)) problems.push({path: where, message: `${where}: completion is for "${arg}", which is not a variable of its uriTemplate`});
      if (typeof(ref) !== 'string') continue;
      if (!names.has(ref)) problems.push({path: where, message: `${where}: completion names ${ref}, which is no action of this module`});
      else completions.add(ref);
    }
  }
  return {name: entry.name, template: r.uriTemplate, shape: parsed.shape};
}

// ---- section 7: prompts and completion actions ----------------------------

const MAX_ARGUMENTS = 16;
const MAX_MESSAGE_BYTES = 8192;
const PLACEHOLDER = /\{\{([A-Za-z0-9_.-]{1,64})\}\}/g;

function promptProblems(doc, spec, names, completions, problems) {
  const list = isObject(spec) && isObject(spec.device) && Array.isArray(spec.device.promptList) ? spec.device.promptList : [];
  const seen = new Set();
  for (const p of list) {
    if (!isObject(p) || typeof(p.name) !== 'string') continue;
    const where = `prompt ${p.name}`;
    if (seen.has(p.name)) problems.push({path: where, message: `promptList names "${p.name}" twice`});
    seen.add(p.name);
    let args = {};
    // arguments that could not be read are said once: what depends on them
    // (a placeholder, a completion's argument) is not also reported
    let known = true;
    if (isObject(p.arguments) && typeof(p.arguments.schema) === 'string') {
      const node = doc == null ? undefined : at(doc, p.arguments.schema);
      const schema = node === undefined ? null : objectSchema(doc, node);
      if (node === undefined) {
        known = false;
        problems.push({path: where, message: `${where}: arguments points to ${p.arguments.schema}, which is not in schema.json`});
      } else if (schema == null) {
        known = false;
        problems.push({path: where, message: `${where}: arguments is not an object schema`});
      } else {
        args = schema.properties;
        const count = Object.keys(args).length;
        if (count > MAX_ARGUMENTS) problems.push({path: where, message: `${where}: ${count} arguments; a prompt has at most ${MAX_ARGUMENTS}`});
        for (const a of Object.keys(args)) {
          if (!isString(args[a])) problems.push({path: where, message: `${where}: its argument "${a}" is not of type "string"`});
        }
        for (const req of schema.required) {
          if (!own(args, req)) problems.push({path: where, message: `${where}: its required argument "${req}" is not one of its properties`});
        }
      }
    }
    for (const m of Array.isArray(p.messages) ? p.messages : []) {
      if (!isObject(m) || typeof(m.text) !== 'string') continue;
      const bytes = Buffer.byteLength(m.text, 'utf8');
      if (bytes > MAX_MESSAGE_BYTES) problems.push({path: where, message: `${where}: a message's text is ${bytes} bytes; a message is at most ${MAX_MESSAGE_BYTES}`});
      for (const hit of m.text.matchAll(PLACEHOLDER)) {
        if (known && !own(args, hit[1])) problems.push({path: where, message: `${where}: {{${hit[1]}}} is not one of its arguments`});
      }
    }
    if (isObject(p.completion)) {
      for (const arg of Object.keys(p.completion)) {
        const ref = p.completion[arg];
        if (known && !own(args, arg)) problems.push({path: where, message: `${where}: completion is for "${arg}", which is not one of its arguments`});
        if (typeof(ref) !== 'string') continue;
        if (!names.has(ref)) problems.push({path: where, message: `${where}: completion names ${ref}, which is no action of this module`});
        else completions.add(ref);
      }
    }
  }
}

// An action named as a completion: its two shapes are fixed.
function completionProblems(doc, entry, problems) {
  const where = `${entry.name}`;
  const input = objectSchema(doc, schemaOf(doc, entry.action, 'input'));
  const inputOk = input != null && isString(input.properties.argument) && isString(input.properties.value)
    && (!own(input.properties, 'context') || (isObject(input.properties.context) && input.properties.context.type === 'object'))
    && input.required.every((r) => ['argument', 'value', 'context'].includes(r));
  if (!inputOk) {
    problems.push({path: where, message: `${where} is named as a completion action: its input must be {argument, value, context}, with argument and value strings and nothing else required`});
  }
  const output = objectSchema(doc, schemaOf(doc, entry.action, 'output'));
  const values = output != null ? output.properties.values : null;
  if (!(isObject(values) && values.type === 'array' && isString(values.items))) {
    problems.push({path: where, message: `${where} is named as a completion action: its output must be {values: string[]}`});
  }
}

// ---- section 8: questions ---------------------------------------------------

const MAX_FORM_PROPERTIES = 8;
const FORM_TYPES = ['string', 'number', 'integer', 'boolean'];
const NOT_FLAT = ['$ref', '$dynamicRef', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentSchemas', 'unevaluatedProperties', 'propertyNames'];
const CREDENTIAL = new Set(['password', 'passwd', 'passphrase', 'pwd', 'secret', 'token', 'credential', 'credentials', 'key', 'apikey', 'card', 'cvv', 'cvc', 'ssn']);
// the words of a name or a title: apiToken, client_secret, "Card number"
const wordsOf = (text) => String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function flatProperty(p) {
  if (!isObject(p) || NOT_FLAT.some((k) => own(p, k)) || own(p, 'properties') || own(p, 'items') || own(p, 'prefixItems')) return false;
  if (own(p, 'enum')) return Array.isArray(p.enum) && p.enum.length > 0 && p.enum.every((v) => typeof(v) === 'string') && (!own(p, 'type') || p.type === 'string');
  return typeof(p.type) === 'string' && FORM_TYPES.includes(p.type);
}

function questionProblems(doc, entry, problems, warnings) {
  const questions = entry.action.questions;
  if (!isObject(questions)) return;
  for (const name of Object.keys(questions)) {
    const q = questions[name];
    if (!isObject(q)) continue;
    const where = `${entry.name} questions.${name}`;
    if (typeof(q.message) === 'string' && /[{}]/.test(q.message.replace(/\{[A-Za-z_][A-Za-z0-9_]{0,63}\}/g, ''))) {
      problems.push({path: where, message: `${where}: its message may hold text and {name} placeholders only (a name is a letter or _, then letters, digits and _)`});
    }
    if (typeof(q.schema) !== 'string') continue;
    const node = doc == null ? undefined : at(doc, q.schema);
    if (node === undefined) {
      problems.push({path: where, message: `${where} points to ${q.schema}, which is not in schema.json`});
      continue;
    }
    const flat = isObject(node) && node.type === 'object' && isObject(node.properties) && !NOT_FLAT.some((k) => own(node, k))
      && (!own(node, 'additionalProperties') || typeof(node.additionalProperties) === 'boolean');
    if (!flat) {
      problems.push({path: where, message: `${where}: its schema is not a flat form: an object schema with properties and nothing that combines or refers to another schema`});
      continue;
    }
    const props = Object.keys(node.properties);
    if (props.length > MAX_FORM_PROPERTIES) problems.push({path: where, message: `${where}: ${props.length} properties; a form has at most ${MAX_FORM_PROPERTIES}`});
    for (const key of props) {
      const p = node.properties[key];
      if (!flatProperty(p)) {
        problems.push({path: where, message: `${where}: its property "${key}" is not a string, number, integer, boolean or an enum of strings`});
        continue;
      }
      if (wordsOf(key).concat(typeof(p.title) === 'string' ? wordsOf(p.title) : []).some((w) => CREDENTIAL.has(w))) {
        warnings.push({path: where, message: `${where}: its property "${key}" reads like a credential; a form must never ask a user for a password, a token, a key or a card number`});
      }
    }
    for (const req of Array.isArray(node.required) ? node.required : []) {
      if (typeof(req) === 'string' && !own(node.properties, req)) problems.push({path: where, message: `${where}: its required "${req}" is not one of its properties`});
    }
  }
}

// ---- section 4: annotations -------------------------------------------------

function annotationWarnings(entry, warnings) {
  const a = entry.action.annotations;
  if (isObject(a) && a.readOnlyHint === true && a.destructiveHint === true) {
    warnings.push({path: `${entry.name} annotations`, message: `${entry.name} annotations: readOnlyHint and destructiveHint are both true; an action that only reads destroys nothing`});
  }
}

function check(spec, schemaDoc) {
  const problems = [];
  const warnings = [];
  const doc = (schemaDoc != null && typeof(schemaDoc) === 'object') ? schemaDoc : null;
  const entries = actionsOf(spec);
  const names = new Set(entries.map((e) => e.name));
  // actions named as a completion, each checked once
  const completions = new Set();
  const resources = [];
  for (const entry of entries) {
    if (doc != null) {
      binaryProblems(doc, entry, problems);
      headerProblems(doc, entry, problems);
    }
    const resource = resourceProblems(doc, entry, names, completions, problems);
    if (resource != null) resources.push(resource);
    questionProblems(doc, entry, problems, warnings);
    annotationWarnings(entry, warnings);
  }
  // no two resources of the module match the same URIs
  const byShape = new Map();
  for (const r of resources) {
    const first = byShape.get(r.shape);
    if (first == null) byShape.set(r.shape, r);
    else problems.push({path: `${r.name} resource`, message: `${r.name} resource: uriTemplate "${r.template}" matches the same URIs as ${first.name}'s ("${first.template}")`});
  }
  promptProblems(doc, spec, names, completions, problems);
  for (const entry of entries) {
    if (completions.has(entry.name)) completionProblems(doc, entry, problems);
  }
  return {problems: problems, warnings: warnings};
}

module.exports = {check, at, deref, actionsOf, shortNameOf, templateOf, MEDIA_TYPE};
