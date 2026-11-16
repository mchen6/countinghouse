'use strict';
// ctx.ask's answer on the main thread (the MCP completeness design, section
// 8; M13). A handler asks by name, and its worker sends
//
//   {token, name, values}
//
// Nothing else of that message is read. The asking module, service and
// action are the call token's entry (lib/call-tokens.js), written by the
// main thread when it sent the call: a module asks only its own declared
// questions, whatever it says of itself.
//
// A call's ask state is made by whoever starts the call (the gateway):
//
//   {askable, answers: Map(key -> content | null), pending}
//
//   askable   whether this call has someone to ask (a modern request that
//             declared form elicitation, module questions on, not a task)
//   answers   what this run may use, by the question's key
//             (lib/module-questions.js keyOf): a validated content object,
//             or null for a decline
//   pending   the question this run asked that has no answer, as the
//             gateway needs it for its form: {key, question, text, schema}
//
// answer(data, workerId) gives the answer, or throws:
//   CALL_TOKEN_INVALID   no live call of this worker's
//   ASK_UNAVAILABLE      no one to ask
//   ASK_NOT_DECLARED     not a question of this action, or a value its
//                        message cannot say
//   ASK_PENDING          no answer yet: the question is recorded on the
//                        call, and the handler ends; it runs again, from
//                        the top, when the client retries with the answer
//
// The state lives as long as its call's token, and is no worker's: a worker
// gets one answer's content, a copy, and nothing else.
const {CountinghouseError} = require('./countinghouse-error');
const questions = require('./module-questions');

const MAX_NAME_CHARS = 64;   // a question's name, as the meta-schema bounds one

const deps = {};
function configure(given = {}) {
  Object.assign(deps, {
    resolve: (token, workerId) => require('./call-tokens').resolve(token, {workerId: workerId}),
    // the module's api.json as the main thread holds it, or null
    specOf: () => null
  }, given);
}
configure();

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const isState = (s) => isObject(s) && typeof(s.askable) === 'boolean' && s.answers instanceof Map && Object.prototype.hasOwnProperty.call(s, 'pending');

// A call's ask state. Anything but a true `askable` and a Map of answers is
// "no one to ask" and "no answers".
function newState({askable = false, answers = null} = {}) {
  return {askable: askable === true, answers: answers instanceof Map ? answers : new Map(), pending: null};
}

// The decision, for a call whose context is known: {state, module,
// serviceID, actionName, spec} (spec: the module's api.json as the main
// thread holds it). A worker's ask comes to it through its token (answer);
// in single-thread mode, which has no tokens, the context rides on the
// call's args (lib/handler-ctx.js attachAsk).
function decide(context, name, values) {
  const c = isObject(context) ? context : {};
  if (!isState(c.state) || c.state.askable !== true) throw new CountinghouseError('ASK_UNAVAILABLE');
  const state = c.state;
  if (typeof(name) !== 'string' || name.length > MAX_NAME_CHARS) throw new CountinghouseError('ASK_NOT_DECLARED');
  const declared = questions.declared(c.spec, c.serviceID, c.actionName, name);
  if (declared == null) throw new CountinghouseError('ASK_NOT_DECLARED');
  // (throws ASK_NOT_DECLARED for a value the message cannot say)
  const text = questions.composed(String(c.module), declared.message, values);
  const key = questions.keyOf({module: String(c.module), serviceID: c.serviceID, action: c.actionName, question: name, text: text});
  if (state.answers.has(key)) {
    const content = state.answers.get(key);
    // the handler's own copy
    return content == null ? null : structuredClone(content);
  }
  // one question a round: the first that has no answer is the one asked
  if (state.pending == null) state.pending = {key: key, question: name, text: text, schema: declared.schema};
  throw new CountinghouseError('ASK_PENDING');
}

// A worker's ask. spec: its own module's api.json, when the caller has it
// at hand (the worker's listener does); else deps.specOf(entry).
function answer(data, workerId, spec) {
  if (!isObject(data) || typeof(data.token) !== 'string') throw new CountinghouseError('CALL_TOKEN_INVALID');
  const entry = deps.resolve(data.token, workerId);
  if (entry == null) throw new CountinghouseError('CALL_TOKEN_INVALID');
  // the outer call's own handler only: a part reached by a hop asks no one
  // yet (M14 follows the chain to the outer call)
  return decide({state: entry.parent == null ? entry.ask : null, module: entry.module, serviceID: entry.serviceID, actionName: entry.actionName,
    spec: spec !== undefined ? spec : deps.specOf(entry)}, data.name, data.values);
}

module.exports = {answer, decide, newState, configure};
