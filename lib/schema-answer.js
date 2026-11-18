'use strict';
// What the schema route (/devices/:id/schema/...) answers: only what
// tools/list advertises (#400's high review, the reviewer's ruling). Each
// usable action's declared schemas (its input, its output, its questions'
// forms) as tools/list shows them: refs put in place, an output's binary
// fields as advertised, cleaned by the gateway's walk (lib/declarations.js
// advertisedPart). A path
// - at or under such a schema: that schema, followed through its own
//   properties (into a string, or into what the walk left out, is no path);
// - at or under an unusable action's declared schema: refused;
// - above declared schemas (the document, a service, an action): a
//   container of only the usable ones, each at its place;
// - anywhere else ($defs, another keyword of the document): no path.
// A path that names nothing advertised is answered as one that names
// nothing at all (POINTER_DEREF_ERROR, the device's own lookup's), so what
// was left out can't be told from what is not there.
const {advertisedPart, actionsOf} = require('./declarations');
const {declaredTokens} = require('./schema-safety');
const clientText = require('./client-text');

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const put = (o, key, value) => Object.defineProperty(o, key, {value, writable: true, enumerable: true, configurable: true});
const isIndex = (t) => /^(0|[1-9][0-9]*)$/.test(t);
const startsWith = (tokens, prefix) => prefix.length <= tokens.length && prefix.every((t, i) => t === tokens[i]);
const samePointer = (a, b) => a.length === b.length && startsWith(a, b);

// the declared schemas of a spec's actions, tool or not (the reviewer's
// ruling: every action the load decided usable is answered, its callers
// over HTTP need its shape): [{tokens, output, question, serviceID,
// actionName}]. Kept per spec object and tool generation.
const partsKept = new WeakMap();
function declaredParts(spec) {
  if (!isObject(spec)) return [];
  const generation = require('./tool-generation').current();
  const kept = partsKept.get(spec);
  if (kept != null && kept.generation === generation) return kept.parts;
  const out = [];
  const add = (holder, output, question, serviceID, actionName) => {
    if (!isObject(holder) || typeof(holder.schema) !== 'string') return;
    const tokens = declaredTokens(holder.schema);
    if (tokens != null) out.push({tokens, output, question, serviceID, actionName});
  };
  for (const {serviceID, action} of actionsOf(spec)) {
    add(action.input, false, false, serviceID, action.name);
    add(action.output, true, false, serviceID, action.name);
    if (isObject(action.questions)) for (const q of Object.keys(action.questions)) add(action.questions[q], false, true, serviceID, action.name);
  }
  partsKept.set(spec, {generation, parts: out});
  return out;
}

// -> {value} or {refused: code}, a copy. doc: the device's schema.json as
// the main thread holds it (raw); decision: the load's, its record
// (lib/hidden-text-verdict.js tokenOf), which with the document, the spec
// and the tool generation keys what is kept, so a path found is worked out
// once, not per request (only one found: what is kept is bounded by the
// schemas, never by what callers ask)
const answersKept = new WeakMap(); // doc -> WeakMap spec -> {stamp, byPath: Map}
const NO_DECISION = {};
function answer(doc, spec, tokens, decision = null) {
  const unusable = (serviceID, actionName) => require('./hidden-text-verdict').recordHas(decision, serviceID, actionName);
  const generation = require('./tool-generation').current();
  const record = decision != null ? decision : NO_DECISION;
  const stamp = {record, size: decision != null && decision.keys != null ? decision.keys.size : 0, generation};
  let bySpec = answersKept.get(doc);
  if (bySpec == null) { bySpec = new WeakMap(); answersKept.set(doc, bySpec); }
  let kept = isObject(spec) ? bySpec.get(spec) : null;
  if (kept == null || kept.stamp.record !== stamp.record || kept.stamp.size !== stamp.size || kept.stamp.generation !== stamp.generation) {
    kept = {stamp, byPath: new Map()};
    if (isObject(spec)) bySpec.set(spec, kept);
  }
  const key = JSON.stringify(tokens);
  let result = kept.byPath.get(key);
  if (result == null) {
    result = made(doc, spec, tokens, unusable);
    if (result.refused == null) kept.byPath.set(key, result);
  }
  return result.refused != null ? {refused: result.refused} : {value: copyOf(result.value)};
}

function made(doc, spec, tokens, unusable) {
  const parts = declaredParts(spec);
  const keyOf = (p) => JSON.stringify([p.serviceID, p.actionName]);
  const partKey = (p) => JSON.stringify([p.output, p.tokens]);
  const byAction = new Map();
  for (const p of parts) {
    if (!byAction.has(keyOf(p))) byAction.set(keyOf(p), []);
    byAction.get(keyOf(p)).push(p);
  }
  // an action is shown as tools/list shows a tool: decided usable, and
  // neither its input nor its output unusable as resolved
  // (hiddenTextDecision); an input that names nothing is advertised as the
  // default schema, an output that names nothing, or no object, is not
  // advertised (the action still shown)
  const usableKept = new Map();
  const usable = (p) => {
    const k = keyOf(p);
    if (!usableKept.has(k)) {
      usableKept.set(k, !unusable(p.serviceID, p.actionName)
        && byAction.get(k).every((q) => q.question || advertisedPart(doc, q.tokens, q.output).state !== 'unusable'));
    }
    return usableKept.get(k);
  };
  const byPointer = new Map();
  for (const p of parts) {
    if (!byPointer.has(partKey(p))) byPointer.set(partKey(p), []);
    byPointer.get(partKey(p)).push(p);
  }
  // a declared schema as shown, by a usable action declaring it (a pointer
  // several declare is shown when one of them is usable), or null
  const shown = (p) => {
    if (!byPointer.get(partKey(p)).some(usable)) return null;
    const part = advertisedPart(doc, p.tokens, p.output);
    if (part.state === 'shown') return part.schema;
    // (an input naming nothing: tools/list's default schema, DEFAULT_SCHEMA)
    if (part.state === 'absent' && !p.output && !p.question) return {type: 'object', properties: {}};
    return null;
  };
  // (one pointer declared as an input and an output is answered in one form,
  // the input's, whatever the spec's order)
  const inputFirst = (a, b) => (a.output === b.output ? 0 : (a.output ? 1 : -1));
  // at or under a declared schema shown: the longest that holds the path
  // (a longer one not shown never hides a shorter one that is: what the
  // shorter shows under it is what tools/list shows)
  const holding = parts.filter((p) => startsWith(tokens, p.tokens)).sort(inputFirst);
  let base = null;
  let baseValue = null;
  for (const p of holding) {
    if (base != null && p.tokens.length <= base.tokens.length) continue;
    const v = shown(p);
    if (v != null) { base = p; baseValue = v; }
  }
  if (base != null) {
    let node = baseValue;
    for (const t of tokens.slice(base.tokens.length)) {
      if (Array.isArray(node) && isIndex(t) && Number(t) < node.length) node = node[Number(t)];
      else if (isObject(node) && Object.hasOwn(node, t)) node = node[t];
      else return {refused: 'POINTER_DEREF_ERROR'};
    }
    return {value: node};
  }
  // (held by none shown: an unusable action's refused; what a usable one
  // doesn't advertise names nothing)
  if (holding.length > 0) return {refused: holding.some((p) => !usable(p)) ? 'MODULE_NOT_LISTED' : 'POINTER_DEREF_ERROR'};
  // above declared schemas: only the shown ones, each at its place
  const under = parts.filter((p) => p.tokens.length > tokens.length && startsWith(p.tokens, tokens))
    .sort((a, b) => (a.tokens.length - b.tokens.length) || inputFirst(a, b));
  const out = {};
  const placed = [];
  for (const p of under) {
    // (one inside a schema already placed is shown there, as part of it)
    if (placed.some((q) => startsWith(p.tokens, q))) continue;
    const rel = p.tokens.slice(tokens.length);
    if (rel.some((t) => clientText.dataHidden(t))) continue;
    const value = shown(p);
    if (value == null) continue;
    let holder = out;
    for (const t of rel.slice(0, -1)) {
      if (!Object.hasOwn(holder, t)) put(holder, t, {});
      holder = holder[t];
    }
    put(holder, rel[rel.length - 1], value);
    placed.push(p.tokens);
  }
  // (nothing shown here is a path that names nothing)
  if (placed.length === 0) return {refused: 'POINTER_DEREF_ERROR'};
  return {value: out};
}

// an answer never shares an object with what is kept or the device's own
// document: only the part asked for is copied
const copyOf = (v) => (v != null && typeof(v) === 'object' ? structuredClone(v) : v);

module.exports = {answer, declaredParts};
