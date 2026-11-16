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

function answer(data, workerId) {
  if (!isObject(data) || typeof(data.token) !== 'string') throw new CountinghouseError('CALL_TOKEN_INVALID');
  const entry = deps.resolve(data.token, workerId);
  if (entry == null) throw new CountinghouseError('CALL_TOKEN_INVALID');
  // the outer call's own handler only: a part reached by a hop asks no one
  // yet (M14 follows the chain to the outer call)
  const state = entry.parent == null ? entry.ask : null;
  if (!isState(state) || state.askable !== true) throw new CountinghouseError('ASK_UNAVAILABLE');
  if (typeof(data.name) !== 'string' || data.name.length > MAX_NAME_CHARS) throw new CountinghouseError('ASK_NOT_DECLARED');
  const declared = questions.declared(deps.specOf(entry), entry.serviceID, entry.actionName, data.name);
  if (declared == null) throw new CountinghouseError('ASK_NOT_DECLARED');
  // (throws ASK_NOT_DECLARED for a value the message cannot say)
  const text = questions.composed(String(entry.module), declared.message, data.values);
  const key = questions.keyOf({module: String(entry.module), serviceID: entry.serviceID, action: entry.actionName, question: data.name, text: text});
  if (state.answers.has(key)) {
    const content = state.answers.get(key);
    // the handler's own copy
    return content == null ? null : structuredClone(content);
  }
  // one question a round: the first that has no answer is the one asked
  if (state.pending == null) state.pending = {key: key, question: data.name, text: text, schema: declared.schema};
  throw new CountinghouseError('ASK_PENDING');
}

module.exports = {answer, newState, configure};
