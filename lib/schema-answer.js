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

// the declared schemas of a spec's tools (the actions tools/list lists as
// tools): [{tokens, output, question, serviceID, actionName}]
function declaredParts(spec) {
  const {isToolAction, completionActionsOf} = require('./mcp/tool-registry');
  const completing = completionActionsOf(spec);
  const out = [];
  const add = (holder, output, question, serviceID, actionName) => {
    if (!isObject(holder) || typeof(holder.schema) !== 'string') return;
    const tokens = declaredTokens(holder.schema);
    if (tokens != null) out.push({tokens, output, question, serviceID, actionName});
  };
  for (const {serviceID, action} of actionsOf(spec)) {
    if (!isToolAction(spec, serviceID, action, completing)) continue;
    add(action.input, false, false, serviceID, action.name);
    add(action.output, true, false, serviceID, action.name);
    if (isObject(action.questions)) for (const q of Object.keys(action.questions)) add(action.questions[q], false, true, serviceID, action.name);
  }
  return out;
}

// -> {value} or {refused: code}. doc: the device's schema.json as the main
// thread holds it (raw); unusable(serviceID, actionName): the load's decision
function answer(doc, spec, tokens, unusable) {
  const parts = declaredParts(spec);
  const keyOf = (p) => `${p.serviceID}\0${p.actionName}`;
  const partKey = (p) => `${p.output ? 'o' : 'i'}\0${p.tokens.join('\0')}`;
  // a tool is shown as tools/list shows it: decided usable, and neither its
  // input nor its output unusable as resolved (hiddenTextDecision); an input
  // that names nothing is advertised as the default schema, an output that
  // names nothing, or no object, is not advertised (the tool still listed)
  const byAction = new Map();
  for (const p of parts) {
    if (!byAction.has(keyOf(p))) byAction.set(keyOf(p), []);
    byAction.get(keyOf(p)).push(p);
  }
  const usableKept = new Map();
  const usable = (p) => {
    const k = keyOf(p);
    if (!usableKept.has(k)) {
      usableKept.set(k, !unusable(p.serviceID, p.actionName)
        && byAction.get(k).every((q) => q.question || advertisedPart(doc, q.tokens, q.output).state !== 'unusable'));
    }
    return usableKept.get(k);
  };
  // a declared schema as shown, by a usable tool declaring it (a pointer
  // several declare is shown when one of them is usable), or null; an output
  // is shown only as an object, as tools/list advertises one
  const byPointer = new Map();
  for (const p of parts) {
    if (!byPointer.has(partKey(p))) byPointer.set(partKey(p), []);
    byPointer.get(partKey(p)).push(p);
  }
  const shown = (p) => {
    if (!byPointer.get(partKey(p)).some(usable)) return null;
    const part = advertisedPart(doc, p.tokens, p.output);
    if (part.state === 'shown') return part.schema;
    // (an input naming nothing: tools/list's default schema, DEFAULT_SCHEMA)
    if (part.state === 'absent' && !p.output && !p.question) return {type: 'object', properties: {}};
    return null;
  };
  // at or under a declared schema: the longest that holds the path
  let base = null;
  for (const p of parts) if (startsWith(tokens, p.tokens) && (base == null || p.tokens.length > base.tokens.length)) base = p;
  if (base != null) {
    const one = parts.find((q) => samePointer(q.tokens, base.tokens) && shown(q) != null);
    // (a usable tool's output or form tools/list doesn't advertise names
    // nothing; an unusable tool's schema is refused)
    if (one == null) return {refused: parts.some((q) => samePointer(q.tokens, base.tokens) && usable(q)) ? 'POINTER_DEREF_ERROR' : 'MODULE_NOT_LISTED'};
    let node = shown(one);
    for (const t of tokens.slice(base.tokens.length)) {
      if (Array.isArray(node) && isIndex(t) && Number(t) < node.length) node = node[Number(t)];
      else if (isObject(node) && Object.hasOwn(node, t)) node = node[t];
      else return {refused: 'POINTER_DEREF_ERROR'};
    }
    return {value: copyOf(node)};
  }
  // above declared schemas: only the shown ones, each at its place
  const under = parts.filter((p) => p.tokens.length > tokens.length && startsWith(p.tokens, tokens))
    .sort((a, b) => a.tokens.length - b.tokens.length);
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
    put(holder, rel[rel.length - 1], copyOf(value));
    placed.push(p.tokens);
  }
  // (nothing shown here is a path that names nothing)
  if (placed.length === 0) return {refused: 'POINTER_DEREF_ERROR'};
  return {value: out};
}

// an answer never shares an object with what is kept (advertisedPart's) or
// the device's own document
const copyOf = (v) => (v != null && typeof(v) === 'object' ? structuredClone(v) : v);

module.exports = {answer, declaredParts};
