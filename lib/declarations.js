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
// a $ref, a $dynamicRef and an action's pointer are resolved as the load's
// safety check resolves them, which is as the runtime does; its sets of
// data keywords and of name-to-schema keywords are the ones walked here
const safety = require('./schema-safety');

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// urn:countinghouse-com:serviceID:echoService -> echoService, as the
// handlers/ directory names a service (lib/handler-map.js)
const shortNameOf = (serviceID) => { const i = String(serviceID).indexOf(':serviceID:'); return i === -1 ? String(serviceID) : String(serviceID).slice(i + ':serviceID:'.length); };

// Keywords whose value is data, never a subschema (a look-alike inside one
// is not a declaration), and keywords whose value maps a NAME to a
// subschema (the names are the author's: a property may be called "default"
// or "oneOf", never a keyword).
const DATA = safety.DATA_KEYWORDS;
const MAPS = safety.SCHEMA_MAPS;
const MAX_REF_HOPS = 16;
// Schema nodes walked in one check, over all the actions. The load lets no
// module through whose actions' schemas come to more than
// schema-safety's MAX_NODES expanded, and a walk visits no more than that,
// so a module the load would serve is far under this; a check that is not
// behind the load's (countinghouse-validate) is bounded by it.
const MAX_VISITS = 4 * safety.MAX_NODES;
// <type>/<subtype>, RFC 6838's restricted names, no parameters
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

// The node a pointer of api.json names in `doc` ("/service/action/input"),
// or undefined: "#" + pointer, decoded per token, as an action's is resolved.
function pointed(doc, pointer) {
  if (doc == null || typeof(pointer) !== 'string') return undefined;
  if (pointer === '/') return doc;
  const node = safety.resolveLocal(doc, `#${pointer}`);
  return node === safety.NOWHERE ? undefined : node;
}

// A schema node with what its $ref names, and what that one's names, and so
// on: the nodes, nearest first, within MAX_REF_HOPS. The runtime
// dereferences schema.json, and a keyword beside a $ref applies with the
// $ref's own (2020-12), so what a node says is read along this chain.
function chainOf(doc, node) {
  const out = [];
  let n = node;
  while (isObject(n) && out.length <= MAX_REF_HOPS && !out.includes(n)) {
    out.push(n);
    if (typeof(n.$ref) !== 'string') break;
    const next = safety.resolveLocal(doc, n.$ref);
    if (next === safety.NOWHERE) break;
    n = next;
  }
  return out;
}
// a keyword's value as the node gives it, itself or through its $ref: the
// nearest that has it, or undefined
function said(doc, node, keyword) {
  for (const n of chainOf(doc, node)) if (own(n, keyword)) return n[keyword];
  return undefined;
}

// One check's walks: the document, its $dynamicAnchors, and the nodes
// visited so far (`over` once they pass MAX_VISITS: the walks stop).
function walksOf(doc) {
  return {doc: doc, anchors: doc == null ? new Map() : safety.dynamicAnchors(doc), visits: 0, over: false};
}

// How a node was reached, as a chain of links back to the root (null):
// {up, step, keyword, list}. step is a pointer token; keyword is the
// keyword a step is ('$ref' for a reference followed), or null for a name
// or an index under one; list marks a keyword whose value is a list. Kept
// as links, and made into a path only for a message.
const trailOf = (at) => { const out = []; for (let l = at; l != null; l = l.up) out.unshift(l.step); return out; };
const keywordsOf = (at) => { const out = []; for (let l = at; l != null; l = l.up) if (l.keyword != null) out.unshift(l); return out; };

// Every schema node under `root`, each once: visit(node, at), where `at` is
// how it was reached. A visit that returns false ends the walk. A schema's
// own keys are keywords: a data keyword's value is not entered, a map
// keyword's value is entered by its names, anything else that holds objects
// is entered as subschemas (an unknown keyword's too: what the gateway does
// not walk is "elsewhere"). A $ref and a $dynamicRef are followed to every
// node they may name. edge(parent, child, at) is told every step taken,
// also one to a node already visited.
function walkAll(walks, root, visit, edge = null) {
  const seen = new Set();
  let stopped = false;
  const schema = (node, at, parent) => {
    if (stopped || walks.over || !isObject(node)) return;
    if (edge != null && parent != null) edge(parent, node, at);
    if (seen.has(node)) return;
    if (++walks.visits > MAX_VISITS) { walks.over = true; return; }
    seen.add(node);
    if (visit(node, at) === false) { stopped = true; return; }
    for (const target of safety.refTargets(walks.doc, walks.anchors, node)) {
      if (target.node !== safety.NOWHERE) schema(target.node, {up: at, step: '$ref', keyword: '$ref', list: false}, node);
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (DATA.has(key) || key === '$ref' || key === '$dynamicRef') continue;
      if (MAPS.has(key)) {
        if (!isObject(value)) continue;
        const under = {up: at, step: key, keyword: key, list: false};
        for (const name of Object.keys(value)) schema(value[name], {up: under, step: name, keyword: null, list: false}, node);
      } else if (Array.isArray(value)) {
        const under = {up: at, step: key, keyword: key, list: true};
        for (let i = 0; i < value.length; i++) schema(value[i], {up: under, step: String(i), keyword: null, list: false}, node);
      } else if (isObject(value)) {
        schema(value, {up: at, step: key, keyword: key, list: false}, node);
      }
    }
  };
  schema(root, null, null);
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
  return pointed(schemaDoc, isObject(action[which]) ? action[which].schema : undefined);
}

// ---- hidden characters in what a schema advertises -----------------------

// What the gateway does with a hidden character inside an advertised schema
// (lib/client-text.js schema; F3-1, the reviewer's rule): the author is told
// here, as the load reads it. An annotation or an unknown keyword holding
// one is left out of what is advertised; one anywhere else makes the schema
// unusable, so the tool is not listed (a question: asking it is
// unavailable). The account is the cleaner's own.
const MAX_HIDDEN_WARNINGS = 20;
// the schema as the gateway advertises it: its local $refs in place (each
// node once, a cycle kept as one), so what the warning says is what the
// gateway does
// (refs resolved from the document's root; the cut, counting every level,
// lists included, is four times past where the cleaner, whose walk the
// gateway's schemas get too, stops, so a schema nested through lists of
// schemas reaches the cleaner's own cut first and depth is decided the same
// way for both;
// a cut or a spent budget leaves the node as declared and is said
// (budget.cut): the part is then unusable, failing closed, #400's high review)
function inlined(doc, node, copies = new Map(), budget = {left: MAX_VISITS, cut: false}, depth = 0) {
  if (depth > 4 * require('./client-text').MAX_DEPTH) { budget.cut = true; return node; }
  if (Array.isArray(node)) return node.map((v) => inlined(doc, v, copies, budget, depth + 1));
  if (!isObject(node)) return node;
  if (copies.has(node)) return copies.get(node);
  if (--budget.left < 0) { budget.cut = true; return node; }
  if (typeof(node.$ref) === 'string' && node.$ref.startsWith('#')) {
    const target = safety.resolveLocal(doc, node.$ref);
    // a boolean schema named by a ref, alone: the boolean itself, as a
    // dereference gives it (never a ref left to dangle)
    if (typeof(target) === 'boolean' && Object.keys(node).length === 1) return target;
    if (target !== safety.NOWHERE && isObject(target)) {
      const rest = Object.assign({}, node);
      delete rest.$ref;
      const out = {};
      copies.set(node, out);
      const resolved = inlined(doc, target, copies, budget, depth + 1);
      Object.assign(out, resolved, inlined(doc, rest, copies, budget, depth + 1));
      return out;
    }
  }
  const out = {};
  copies.set(node, out);
  for (const key of Object.keys(node)) Object.defineProperty(out, key, {value: inlined(doc, node[key], copies, budget, depth + 1), writable: true, enumerable: true, configurable: true});
  return out;
}
// (a walk of its own, with its own budget: what it finds never costs the
// checks that refuse a module their count)
//
// parts: one decision's schemas, [{root, where, output}]: a tool's input and
// output (either unusable, the tool is not listed, and every finding says
// so), or a question's form. An output is walked as advertised, its binary
// fields replaced (lib/binary-fields.js advertisedSchema), as the gateway
// walks it.
// It never throws and never stops the other checks (walks.over is theirs):
// the walks it makes are bounded, and should one still overflow the stack,
// it says so in a warning of its own (#400's high review).
const hiddenDocs = new WeakMap();
// -> whether the parts leave it unusable (a tool not listed, a question
// unavailable): the load's one decision (#400), which the gateway and every
// route take from it. Nested too deeply to check: unusable, failing closed,
// as the gateway's own walk is past MAX_DEPTH.
function hiddenTextWarnings(doc, parts, kind, warnings) {
  try {
    return hiddenTextFindings(doc, parts, kind, warnings);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    const where = parts.map((p) => p.where).join(', ');
    warnings.push({path: where, message: `${require('./client-text').line(where)}: nested too deeply to check for hidden characters, so the ${kind === 'question' ? 'question is unavailable' : (kind === 'action' ? 'action is refused' : 'tool is not listed')}`});
    return true;
  }
}
function hiddenTextFindings(doc, parts, kind, warnings) {
  const clientText = require('./client-text');
  // the fast path: a document holding no hidden character has none to warn of
  if (isObject(doc)) {
    // (a document too deep for the fast path is walked part by part, so
    // only a part that is itself too deep fails closed)
    if (!hiddenDocs.has(doc)) {
      let holds = true;
      try { holds = clientText.holdsHidden(doc); } catch (e) { if (!(e instanceof RangeError)) throw e; }
      hiddenDocs.set(doc, holds);
    }
    if (!hiddenDocs.get(doc)) return false;
  }
  // the gateway's own account of what it does (lib/client-text.js schema's
  // report), on the schema as advertised (its local $refs in place): one
  // walk, one predicate, never a second judgement that could drift from it
  const found = [];
  let unusable = false;
  for (const {root, where, output} of parts) {
    if (!isObject(root)) continue;
    const report = [];
    const budget = {left: MAX_VISITS, cut: false};
    const whole = inlined(doc, root, new Map(), budget);
    if (budget.cut) {
      unusable = true;
      report.push({path: '/', what: 'its $refs (nested too deeply, or too many, to put in place)', effect: 'unusable'});
    }
    const shown = output ? require('./binary-fields').advertisedSchema(whole) : whole;
    if (clientText.schema(shown, {report}).unusable) unusable = true;
    for (const f of report) found.push({where, f});
  }
  if (found.length === 0) return unusable;
  const so = unusable ? (kind === 'question' ? 'asking it is unavailable' : (kind === 'action' ? 'the action is refused' : 'the tool is not listed'))
    : 'it is left out of what is advertised';
  const said = new Set();
  // names, keys, $ref values and path segments as one clean line each: a
  // finding is about hidden characters, and never carries one to the
  // operator's log or countinghouse-validate (#400's high review)
  const shown = (t) => safety.declaredText(clientText.line(t));
  for (const {where, f} of found) {
    const message = `${shown(where)}: ${shown(f.path || '/')}: ${shown(f.what)} has a hidden character, so ${so}`;
    if (said.has(message)) continue;
    said.add(message);
    warnings.push({path: where, message});
    if (said.size >= MAX_HIDDEN_WARNINGS) break;
  }
  return unusable;
}

// ---- section 1: binary output fields ------------------------------------

// a node that claims to be binary: base64 with a media type, whatever its type
const claimsBinary = (node) => isObject(node) && node.contentEncoding === 'base64' && own(node, 'contentMediaType');

// The runtime dereferences schema.json before the gateway maps an output's
// binary fields (lib/binary-fields.js), so a $ref that leads to one would
// make it a field wherever the $ref stands: a second one, when the field is
// also declared inline. Every binary field is declared inline, once; a $ref
// under an output may lead to none (the reviewer's ruling in M3).
function binaryProblems(walks, entry, problems) {
  const output = schemaOf(walks.doc, entry.action, 'output');
  if (output === undefined) return;
  const where = `${entry.name} output`;
  // every node under the output that claims to be binary, by whatever way
  // it is reached, with every step taken (the one walk that is counted)
  const claims = [];
  const parents = new Map();   // node -> the nodes a step leads to it from
  const refs = [];             // {target, at}: each $ref followed
  walkAll(walks, output, (node, at) => { if (claimsBinary(node)) claims.push({node: node, at: at}); }, (parent, child, at) => {
    if (!parents.has(child)) parents.set(child, []);
    parents.get(child).push(parent);
    if (at.keyword === '$ref') refs.push({target: child, at: at});
  });
  if (walks.over || claims.length === 0) return;
  const reached = (at) => (at == null ? 'the output itself' : `/${trailOf(at).join('/')}`);
  // the nodes a binary field is reached from: back along the steps
  const leads = new Set(claims.map((c) => c.node));
  for (const queue = [...leads]; queue.length > 0;) {
    for (const parent of parents.get(queue.pop()) || []) {
      if (!leads.has(parent)) { leads.add(parent); queue.push(parent); }
    }
  }
  for (const {target, at} of refs) {
    if (leads.has(target)) {
      problems.push({path: where, message: `${where} ${reached(at)}: a binary field is reached through a $ref here; declare it inline, under properties or items, at most ${binary.MAX_DEPTH} levels deep`});
    }
  }
  // the fields the gateway maps: properties and items only, 8 levels
  const fields = binary.binaryFields(output);
  const mapped = new Set(binary.binaryNodes(output));
  if (fields.length > binary.MAX_BINARY_FIELDS) {
    problems.push({path: where, message: `${where} declares ${fields.length} binary fields; an action may declare at most ${binary.MAX_BINARY_FIELDS}`});
  }
  for (const {node, at} of claims) {
    if (typeof(node.contentMediaType) !== 'string' || !MEDIA_TYPE.test(node.contentMediaType)) {
      problems.push({path: where, message: `${where} ${reached(at)}: contentMediaType ${JSON.stringify(String(node.contentMediaType).slice(0, 80))} is not a media type of the form type/subtype`});
      continue;
    }
    const keywords = keywordsOf(at);
    // mapped where it stands, or first met through a $ref (said above)
    if (mapped.has(node) || keywords.some((k) => k.keyword === '$ref')) continue;
    if (node.type !== 'string') {
      problems.push({path: where, message: `${where} ${reached(at)}: a binary field's type is exactly "string" (no union type); declare it inline, under properties or items`});
      continue;
    }
    const other = keywords.find((k) => k.keyword !== 'properties' && k.keyword !== 'items');
    const why = other !== undefined ? `is under ${other.keyword}`
      : keywords.some((k) => k.keyword === 'items' && k.list) ? 'is under an items that is a list of schemas (give one schema for every item)'
        : `is deeper than ${binary.MAX_DEPTH} levels`;
    problems.push({path: where, message: `${where} ${reached(at)}: this binary field ${why}; declare it inline, under properties or items, at most ${binary.MAX_DEPTH} levels deep`});
  }
}

// ---- section 4: x-mcp-header ---------------------------------------------

function headerProblems(walks, entry, problems) {
  const input = schemaOf(walks.doc, entry.action, 'input');
  if (input === undefined) return;
  const where = `${entry.name} input`;
  let found;
  // the first is enough: the walk ends there
  walkAll(walks, input, (node, at) => {
    if (!own(node, 'x-mcp-header')) return true;
    found = at;
    return false;
  });
  if (found !== undefined) {
    problems.push({path: where, message: `${where} ${found == null ? '' : `/${trailOf(found).join('/')} `}declares x-mcp-header: x-mcp-header is not served by this runtime (the server's side of it is not designed), so a schema may not carry it`.replace(/ {2,}/g, ' ')});
  }
}

// ---- shared by sections 3, 7 and 8 ---------------------------------------

// `node` read as an object schema, with what its $ref names: {properties,
// required}, or null when it is not one. Properties on both sides of a $ref
// are all the object's (the nearest wins a name), and so are the required.
function objectSchema(doc, node) {
  if (said(doc, node, 'type') !== 'object') return null;
  const properties = Object.create(null);
  const required = [];
  for (const n of chainOf(doc, node)) {
    if (own(n, 'properties')) {
      if (!isObject(n.properties)) return null;
      for (const key of Object.keys(n.properties)) if (!own(properties, key)) properties[key] = n.properties[key];
    }
    for (const r of Array.isArray(n.required) ? n.required : []) if (typeof(r) === 'string' && !required.includes(r)) required.push(r);
  }
  return {properties: properties, required: required};
}
// of type "string", itself or through its $ref
const isString = (doc, p) => said(doc, p, 'type') === 'string';

// ---- section 3: resources --------------------------------------------------

const MAX_VARIABLES = 8;
// A template is segments between slashes (RFC 6570 level 1, the subset this
// layer takes: no operator, no modifier, no percent-escape, nothing a URI
// gives another meaning). A segment is unreserved characters with at most
// one {name} variable among them: a variable matches a segment's
// characters only (the design, section 3), so two in one segment could not
// be read back from a URI.
const SEGMENT_CHARS = /^(?:[A-Za-z0-9._~-]|\{[A-Za-z_][A-Za-z0-9_]{0,63}\})+$/;
const SEGMENT = /^([A-Za-z0-9._~-]*)(?:\{([A-Za-z_][A-Za-z0-9_]{0,63})\}([A-Za-z0-9._~-]*))?$/;

// -> {variables, segments: [{before, variable, after}]} (variable null for a
// literal segment, which is all in `before`), or {error}
function templateOf(template) {
  if (typeof(template) !== 'string' || template === '') return {error: 'it is empty'};
  const segments = [];
  for (const seg of template.split('/')) {
    if (seg === '') return {error: 'it has an empty segment (a leading, trailing or doubled /)'};
    if (!SEGMENT_CHARS.test(seg)) return {error: `its segment ${JSON.stringify(seg.slice(0, 40))} is not letters, digits, . _ ~ - and {name} variables`};
    const m = SEGMENT.exec(seg);
    if (m == null) return {error: `its segment ${JSON.stringify(seg.slice(0, 40))} has more than one variable; there is at most one variable in a segment (two could not be read back from a URI)`};
    const part = {before: m[1], variable: m[2] === undefined ? null : m[2], after: m[3] === undefined ? '' : m[3]};
    // what it is with its variable empty
    if (['.', '..'].includes(part.before + part.after)) return {error: 'it has a segment that is, or with an empty variable would be, . or ..'};
    segments.push(part);
  }
  const variables = segments.filter((p) => p.variable != null).map((p) => p.variable);
  const twice = variables.find((v, i) => variables.indexOf(v) !== i);
  if (twice !== undefined) return {error: `it names {${twice}} twice`};
  if (variables.length > MAX_VARIABLES) return {error: `it has ${variables.length} variables; a template has at most ${MAX_VARIABLES} variables`};
  return {variables: variables, segments: segments};
}

// Whether some path matches both templates (as templateOf gives them): the
// same number of segments, and in each place a string both segments match.
// A variable is taken to match any run of a segment's characters, the empty
// one too: that only finds more.
function templatesOverlap(a, b) {
  if (a.segments.length !== b.segments.length) return false;
  const fits = (literal, p) => literal.length >= p.before.length + p.after.length && literal.startsWith(p.before) && literal.endsWith(p.after);
  return a.segments.every((p, i) => {
    const q = b.segments[i];
    if (p.variable == null && q.variable == null) return p.before === q.before;
    if (p.variable == null) return fits(p.before, q);
    if (q.variable == null) return fits(q.before, p);
    return (p.before.startsWith(q.before) || q.before.startsWith(p.before)) && (p.after.endsWith(q.after) || q.after.endsWith(p.after));
  });
}

function resourceProblems(doc, entry, names, completions, problems, reads = new Set()) {
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
      else if (!isString(doc, schema.properties[v])) problems.push({path: where, message: `${where}: its variable {${v}} is an input property that is not of type "string"`});
    }
    for (const req of schema.required) {
      if (!parsed.variables.includes(req)) problems.push({path: where, message: `${where}: the required input "${req}" is not a variable of its uriTemplate, so no read could give it`});
    }
  }
  if (Array.isArray(r.changesWith)) {
    for (const ref of r.changesWith) {
      if (typeof(ref) === 'string' && !names.has(ref)) problems.push({path: where, message: `${where}: changesWith names ${ref}, which is no action of this module`});
      // its own read: each read would announce a change, and a client that
      // reads again on each would loop, billed every time
      else if (ref === entry.name) problems.push({path: where, message: `${where}: changesWith names ${ref}, the resource's own read, which changes nothing`});
      // another resource's read, likewise (F3-4): two resources naming each
      // other's read would loop a client that reads again on each
      else if (reads.has(ref)) problems.push({path: where, message: `${where}: changesWith names ${ref}, another resource's read, which changes nothing`});
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
  return {name: entry.name, template: r.uriTemplate, parsed: parsed};
}

// ---- section 7: prompts and completion actions ----------------------------

const MAX_ARGUMENTS = 16;
const MAX_MESSAGE_BYTES = 8192;
// a placeholder's name, and anything in double braces
const PLACEHOLDER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const DOUBLE_BRACES = /\{\{([^{}]*)\}\}/g;

function promptProblems(doc, spec, names, completions, problems, warnings) {
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
      const node = pointed(doc, p.arguments.schema);
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
          if (!isString(doc, args[a])) problems.push({path: where, message: `${where}: its argument "${a}" is not of type "string"`});
          // (a name the client sends back can't be cleaned: the prompt is left out, M18)
          else if (require('./client-text').hasHidden(a)) warnings.push({path: where, message: `${where}: its argument ${JSON.stringify(require('./client-text').line(a.slice(0, 80)))} is named with a hidden character, so the prompt is not listed`});
          // {{name}} is the one way an argument reaches a message
          else if (!PLACEHOLDER_NAME.test(a)) warnings.push({path: where, message: `${where}: its argument ${JSON.stringify(a.slice(0, 80))} can never be named in a message ({{name}} takes letters, digits, _ . and -)`});
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
      for (const hit of m.text.matchAll(DOUBLE_BRACES)) {
        if (!PLACEHOLDER_NAME.test(hit[1])) {
          // text, as it may well be meant (a ${{ … }} of another tool's); said, since it may be a slip
          warnings.push({path: where, message: `${where}: ${JSON.stringify(hit[0].slice(0, 80))} is not a placeholder (a name is letters, digits, _ . and -); it is sent as written`});
        } else if (known && !own(args, hit[1])) {
          problems.push({path: where, message: `${where}: {{${hit[1]}}} is not one of its arguments`});
        }
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
  const inputOk = input != null && isString(doc, input.properties.argument) && isString(doc, input.properties.value)
    && (!own(input.properties, 'context') || said(doc, input.properties.context, 'type') === 'object')
    && input.required.every((r) => ['argument', 'value', 'context'].includes(r));
  if (!inputOk) {
    problems.push({path: where, message: `${where} is named as a completion action: its input must be {argument, value, context}, with argument and value strings and nothing else required`});
  }
  const output = objectSchema(doc, schemaOf(doc, entry.action, 'output'));
  const values = output != null ? output.properties.values : null;
  if (!(said(doc, values, 'type') === 'array' && isString(doc, said(doc, values, 'items')))) {
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

// A form goes to the client as it is declared (elicitation's
// requestedSchema), and a user reads its texts. So a form holds only what a
// form field takes, each within a bound, and no text of it carries a
// control or bidi character.
const MAX_ENUM_VALUES = 64;
const MAX_VALUE_CHARS = 256;
const MAX_TITLE_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_PROPERTY_NAME_CHARS = 64;
const FORMATS = ['email', 'uri', 'date', 'date-time'];
const FIELD_KEYWORDS = {
  string: ['type', 'title', 'description', 'default', 'minLength', 'maxLength', 'format'],
  number: ['type', 'title', 'description', 'default', 'minimum', 'maximum'],
  integer: ['type', 'title', 'description', 'default', 'minimum', 'maximum'],
  boolean: ['type', 'title', 'description', 'default'],
  enum: ['type', 'title', 'description', 'default', 'enum', 'enumNames']
};
const FORM_KEYWORDS = ['type', 'properties', 'required', 'additionalProperties', 'title', 'description'];
// the C0 and C1 controls, DEL, the line and paragraph separators and the
// bidi controls (as lib/output-lines.js takes them from a line; a tab too)
const UNCLEAN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

// -> null, or what is wrong with a text a user is shown
function textProblem(what, value, max) {
  if (typeof(value) !== 'string') return `${what} is not text`;
  if (value.length > max) return `${what} is ${value.length} characters; it is at most ${max} characters`;
  if (UNCLEAN.test(value)) return `${what} has a control or bidi character`;
  return null;
}

// -> null, or what is wrong with one property of a form
function fieldProblem(p) {
  const notOne = 'is not a string, number, integer, boolean or an enum of strings';
  if (!isObject(p) || NOT_FLAT.some((k) => own(p, k)) || own(p, 'properties') || own(p, 'items') || own(p, 'prefixItems')) return notOne;
  let kind;
  if (own(p, 'enum')) {
    if (!Array.isArray(p.enum) || p.enum.length === 0 || !p.enum.every((v) => typeof(v) === 'string') || (own(p, 'type') && p.type !== 'string')) return notOne;
    kind = 'enum';
  } else {
    if (typeof(p.type) !== 'string' || !FORM_TYPES.includes(p.type)) return notOne;
    kind = p.type;
  }
  const extra = Object.keys(p).find((k) => !FIELD_KEYWORDS[kind].includes(k));
  if (extra !== undefined) return `may not carry ${extra} (${kind === 'enum' ? 'an enum' : `a ${kind}`} field takes ${FIELD_KEYWORDS[kind].join(', ')})`;
  if (own(p, 'title')) { const bad = textProblem('its title', p.title, MAX_TITLE_CHARS); if (bad != null) return bad; }
  if (own(p, 'description')) { const bad = textProblem('its description', p.description, MAX_DESCRIPTION_CHARS); if (bad != null) return bad; }
  if (kind === 'enum') {
    if (p.enum.length > MAX_ENUM_VALUES) return `has ${p.enum.length} values; an enum has at most ${MAX_ENUM_VALUES} values`;
    for (const v of p.enum) { const bad = textProblem('a value of its enum', v, MAX_VALUE_CHARS); if (bad != null) return bad; }
    if (new Set(p.enum).size !== p.enum.length) return 'names a value of its enum twice';
    if (own(p, 'enumNames')) {
      if (!Array.isArray(p.enumNames) || p.enumNames.length !== p.enum.length) return 'has enumNames that are not one name for each value';
      for (const v of p.enumNames) { const bad = textProblem('one of its enumNames', v, MAX_VALUE_CHARS); if (bad != null) return bad; }
    }
    if (own(p, 'default') && !p.enum.includes(p.default)) return 'has a default that is not one of its values';
    return null;
  }
  if (kind === 'string') {
    for (const k of ['minLength', 'maxLength']) if (own(p, k) && !(Number.isSafeInteger(p[k]) && p[k] >= 0)) return `has a ${k} that is not a length`;
    if (own(p, 'format') && !FORMATS.includes(p.format)) return `has a format a form does not take (it takes ${FORMATS.join(', ')})`;
    if (own(p, 'default')) { const bad = textProblem('its default', p.default, MAX_VALUE_CHARS); if (bad != null) return bad; }
    return null;
  }
  if (kind === 'boolean') return (own(p, 'default') && typeof(p.default) !== 'boolean') ? 'has a default that is not a boolean' : null;
  for (const k of ['minimum', 'maximum']) if (own(p, k) && !(typeof(p[k]) === 'number' && Number.isFinite(p[k]))) return `has a ${k} that is not a number`;
  if (own(p, 'default') && !(kind === 'integer' ? Number.isSafeInteger(p.default) : (typeof(p.default) === 'number' && Number.isFinite(p.default)))) return `has a default that is not ${kind === 'integer' ? 'an integer' : 'a number'}`;
  return null;
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
    if (typeof(q.message) === 'string' && UNCLEAN.test(q.message)) {
      problems.push({path: where, message: `${where}: its message has a control or bidi character`});
    }
    if (typeof(q.schema) !== 'string') continue;
    const node = pointed(doc, q.schema);
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
    const extra = Object.keys(node).find((k) => !FORM_KEYWORDS.includes(k));
    if (extra !== undefined) problems.push({path: where, message: `${where}: its schema may not carry ${extra} (a form takes ${FORM_KEYWORDS.join(', ')})`});
    hiddenTextWarnings(doc, [{root: node, where}], 'question', warnings);
    for (const [what, max] of [['title', MAX_TITLE_CHARS], ['description', MAX_DESCRIPTION_CHARS]]) {
      const bad = own(node, what) ? textProblem(`its ${what}`, node[what], max) : null;
      if (bad != null) problems.push({path: where, message: `${where}: ${bad}`});
    }
    const props = Object.keys(node.properties);
    if (props.length > MAX_FORM_PROPERTIES) problems.push({path: where, message: `${where}: ${props.length} properties; a form has at most ${MAX_FORM_PROPERTIES}`});
    for (const key of props) {
      const p = node.properties[key];
      const badName = textProblem('its name', key, MAX_PROPERTY_NAME_CHARS);
      if (badName != null) {
        problems.push({path: where, message: `${where}: its property ${JSON.stringify(key.slice(0, 80))}: ${badName}`});
        continue;
      }
      const bad = fieldProblem(p);
      if (bad != null) {
        problems.push({path: where, message: `${where}: its property "${key}" ${bad}`});
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
  // the module's resource reads: no changesWith may name one (F3-4)
  const reads = new Set(entries.filter((e) => isResourceRead(e.action)).map((e) => e.name));
  // actions named as a completion, each checked once
  const completions = new Set();
  const resources = [];
  const walks = walksOf(doc);
  for (const entry of entries) {
    if (doc != null && !walks.over) {
      try {
        binaryProblems(walks, entry, problems);
        headerProblems(walks, entry, problems);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        // nested past the stack: the load's safety check refuses it too
        walks.over = true;
      }
    }
    const resource = resourceProblems(doc, entry, names, completions, problems, reads);
    if (resource != null) resources.push(resource);
    questionProblems(doc, entry, problems, warnings);
    annotationWarnings(entry, warnings);
  }
  // no two resources of the module match the same URI: each against the
  // ones before it, said once
  for (let i = 1; i < resources.length; i++) {
    const r = resources[i];
    const first = resources.slice(0, i).find((earlier) => templatesOverlap(earlier.parsed, r.parsed));
    if (first != null) problems.push({path: `${r.name} resource`, message: `${r.name} resource: uriTemplate "${r.template}" matches the same URIs as ${first.name}'s ("${first.template}")`});
  }
  promptProblems(doc, spec, names, completions, problems, warnings);
  for (const entry of entries) {
    if (completions.has(entry.name)) completionProblems(doc, entry, problems);
  }
  // a tool's schemas with hidden text (F3-1): only an action that is a tool,
  // as lib/mcp/tool-registry.js's buildToolTargets decides (a resource
  // action or a completion action never is, so the gateway never unlists
  // it for this). After the prompts, which name completion actions too.
  // (outside the walks' try: it never sets walks.over)
  // hiddenUnlisted: the actions it makes unusable, as [serviceID, action
  // name] pairs (the service's own key, never its short name, which two
  // services may share) -- the load's one decision (#400), which
  // lib/hidden-text-verdict.js holds for tools/list, tools/call, tasks and
  // the HTTP routes alike. Every action is decided (a resource, a completion
  // action or one with no description is no tool, but invoke-action, add-job
  // and get-spec still reach it; the high review of #400); a tool's warning
  // says it is not listed, any other's that it is refused.
  const hiddenUnlisted = [];
  if (doc != null) {
    for (const entry of entries) {
      const tool = !isObject(entry.action.resource) && !completions.has(entry.name) &&
        typeof(entry.action.description) === 'string' && require('./client-text').line(entry.action.description).trim() !== '';
      const unusable = hiddenTextWarnings(doc, [{root: schemaOf(doc, entry.action, 'input'), where: `${entry.name} input`},
        {root: schemaOf(doc, entry.action, 'output'), where: `${entry.name} output`, output: true}], tool ? 'tool' : 'action', warnings);
      if (unusable) hiddenUnlisted.push([entry.serviceID, entry.action.name]);
    }
  }
  if (walks.over) {
    problems.unshift({path: 'schema.json', message: `schema.json is too large for its declarations to be checked (its actions' schemas come to more than ${MAX_VISITS} schema nodes, or one is nested too deeply); the load refuses such a schema.json`});
  }
  // A message names what the module declares, and it is read in a log line
  // and, from countinghouse-validate, by an MCP client: each is cut, and
  // loses its control and bidi characters, here, whoever reads it.
  const shown = ({path, message}) => ({path: safety.declaredText(path), message: safety.declaredText(message)});
  return {problems: problems.map(shown), warnings: warnings.map(shown), hiddenUnlisted};
}

// Whether an action is a resource's read: a resource whose uriTemplate is a
// template that parses. The one test of it (this file's changesWith check,
// the device manager's per-device reads, the listen hub's guard: F3-4), as
// lib/mcp/resources.js serves one.
function isResourceRead(action) {
  if (!isObject(action) || !isObject(action.resource) || typeof(action.resource.uriTemplate) !== 'string') return false;
  const t = templateOf(action.resource.uriTemplate);
  return t != null && t.error == null;
}

module.exports = {check, pointed, chainOf, actionsOf, shortNameOf, templateOf, templatesOverlap, isResourceRead, MEDIA_TYPE, MAX_VISITS};
