'use strict';
// the dialog's text as it leaves for the client (M18)
const clientText = require('./client-text');
// A module's question (the MCP completeness design, section 8; M13), as the
// main thread makes it. A handler asks by name:
//
//   const answer = await ctx.ask('overwrite', {id: input.id});
//
// The question is declared (api.json's `questions`: a message and a pointer
// to its form, checked by lib/declarations.js), never composed by the
// module. The worker sends the name and the values; everything here is the
// main thread's:
//
//   declared(spec, serviceID, action, name)   the action's own declaration
//   composed(module, message, values)         what the user reads:
//                                             "<module name>: <message>"
//   keyOf({module, serviceID, action,         what an answer is held under:
//          question, text})                   only a question with the same
//                                             text gets it
//
// So the sentence a user reads was reviewed at install, the user sees which
// third-party module is asking, and a module can ask only its own declared
// questions. Pure: no state, no file, no key.
const crypto = require('crypto');
const {CountinghouseError} = require('./countinghouse-error');
const outputLines = require('./output-lines');

const MAX_VALUE_CHARS = 200;
const MAX_DIALOG_CHARS = 1000;
const MAX_MODULE_NAME_CHARS = 64;
// a placeholder of a question's message, as lib/declarations.js checks one
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;
const KEY_LABEL = 'countinghouse-question/1';

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// by characters, never half of one
const cut = (s, max) => { const points = Array.from(s); return points.length <= max ? s : points.slice(0, max).join(''); };
// no control or bidi character, as a module's output line has none
// (lib/output-lines.js); a tab is a space
const cleaned = (s) => outputLines.clean(s).replace(/\t/g, ' ');

// a value as the dialog says it, or undefined for one it does not take
function said(value) {
  if (typeof(value) === 'string') return cut(cleaned(value), MAX_VALUE_CHARS);
  if (typeof(value) === 'number' && Number.isFinite(value)) return String(value);
  if (typeof(value) === 'boolean') return String(value);
  return undefined;
}

// The dialog's text. Each {name} of the message is replaced by its value,
// once: what is put in is never read again as a placeholder. A value that
// is missing, or is not a string, a finite number or a boolean, is the
// module's error (ASK_NOT_DECLARED); its text names the placeholder and
// never the value.
function composed(moduleName, message, values) {
  const given = isObject(values) ? values : {};
  const text = String(message).replace(PLACEHOLDER, (all, name) => {
    const value = own(given, name) ? said(given[name]) : undefined;
    if (value === undefined) throw new CountinghouseError('ASK_NOT_DECLARED', `no value for {${name}}, or one that is not a string, a number or a boolean`);
    return value;
  });
  // and the whole of it as it leaves for the client: every hidden character
  // a space (M18, lib/client-text.js; the load refuses only controls and bidi),
  // cut first, so no joiner kept for what the cut takes off is left at its end
  return clientText.line(cut(`${cut(cleaned(String(moduleName)), MAX_MODULE_NAME_CHARS)}: ${text}`, MAX_DIALOG_CHARS));
}

// A question's key: 43 characters of base64url, a SHA-256 over one JSON
// array (no two different questions give the same bytes).
function keyOf({module, serviceID, action, question, text} = {}) {
  const fields = [module, serviceID, action, question, text];
  if (!fields.every((f) => typeof(f) === 'string')) throw new Error('module-questions: a key is of a module, a service, an action, a question and its text');
  return crypto.createHash('sha256').update(JSON.stringify([KEY_LABEL].concat(fields)), 'utf8').digest('base64url');
}

// The action's own declaration of the question `name`, from api.json as the
// main thread holds it: {message, schema}, or null. Own properties only,
// and nothing that is not a message and a pointer (the meta-schema refuses
// such a module at load; this does not rest on that).
function declared(spec, serviceID, actionName, name) {
  if (typeof(serviceID) !== 'string' || typeof(actionName) !== 'string' || typeof(name) !== 'string' || name === '') return null;
  const services = isObject(spec) && isObject(spec.device) && isObject(spec.device.serviceList) ? spec.device.serviceList : null;
  const service = services != null && own(services, serviceID) && isObject(services[serviceID]) ? services[serviceID] : null;
  const actions = service != null && Array.isArray(service.actionList) ? service.actionList : [];
  const action = actions.find((a) => isObject(a) && a.name === actionName);
  const all = action != null && isObject(action.questions) ? action.questions : null;
  const q = all != null && own(all, name) ? all[name] : null;
  if (!isObject(q) || typeof(q.message) !== 'string' || typeof(q.schema) !== 'string') return null;
  return {message: q.message, schema: q.schema};
}

// Whether the action declares any question at all (its retry's
// requestState and inputResponses are then never taken from its arguments).
function asks(spec, serviceID, actionName) {
  const services = isObject(spec) && isObject(spec.device) && isObject(spec.device.serviceList) ? spec.device.serviceList : null;
  const service = services != null && typeof(serviceID) === 'string' && own(services, serviceID) && isObject(services[serviceID]) ? services[serviceID] : null;
  const action = (service != null && Array.isArray(service.actionList) ? service.actionList : []).find((a) => isObject(a) && a.name === actionName);
  return action != null && isObject(action.questions) && Object.keys(action.questions).length > 0;
}

// What an answer is checked against: the form's own rules, with no property
// but the form's own, and without what only a client reads. A form may carry
// enumNames (lib/declarations.js lets it), which a validator does not know
// and would refuse to compile.
const CLIENT_ONLY = ['enumNames'];
function answerSchema(form) {
  const properties = {};
  const declaredProperties = isObject(form) && isObject(form.properties) ? form.properties : {};
  for (const name of Object.keys(declaredProperties)) {
    const field = isObject(declaredProperties[name]) ? Object.assign({}, declaredProperties[name]) : declaredProperties[name];
    if (isObject(field)) for (const k of CLIENT_ONLY) delete field[k];
    // (a property may be named __proto__: defined, never assigned)
    Object.defineProperty(properties, name, {value: field, enumerable: true, writable: true, configurable: true});
  }
  return {type: 'object', properties: properties,
    required: isObject(form) && Array.isArray(form.required) ? form.required.filter((r) => typeof(r) === 'string') : [], additionalProperties: false};
}

module.exports = {composed, keyOf, declared, asks, answerSchema, MAX_VALUE_CHARS, MAX_DIALOG_CHARS};
