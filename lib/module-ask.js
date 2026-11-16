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
//   {askable, answers: Map(key -> content | null), pending, rounds,
//    unavailable}
//
//   askable       whether this call has someone to ask (a modern request
//                 that declared form elicitation, module questions on, not
//                 a task)
//   answers       what this run may use, by the question's key
//                 (lib/module-questions.js keyOf): a validated content
//                 object, or null for a decline
//   pending       the question this run asked that has no answer, as the
//                 gateway needs it for its form: {key, question, text,
//                 schema}
//   rounds        key -> the rounds a question has had with no answer
//   unavailable   the keys whose three rounds brought none: asked again,
//                 such a question is ASK_UNAVAILABLE
//
// The gateway drives a call's rounds with begin (before the handler runs:
// the state, with what the retry brought) and formOf (after it ended with
// ASK_PENDING: the form and the requestState its retry must carry). The
// handler waits across a stateless transport by running again.
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
const requestState = require('./request-state');
const {declaresForm} = require('./elicitation-clients');

const MAX_NAME_CHARS = 64;   // a question's name, as the meta-schema bounds one
const MAX_ROUNDS = 3;
// the one request of an input_required answer, and its response's key
const RESPONSE_ID = 'answer';
const QUESTION_KEY = /^[A-Za-z0-9_-]{43}$/;
const QUESTION_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

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
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isState = (s) => isObject(s) && typeof(s.askable) === 'boolean' && s.answers instanceof Map && own(s, 'pending') && s.rounds instanceof Map && s.unavailable instanceof Set;

// A call's ask state. Anything but a true `askable` and a Map of answers is
// "no one to ask" and "no answers".
function newState({askable = false, answers = null} = {}) {
  return {askable: askable === true, answers: answers instanceof Map ? answers : new Map(), pending: null, rounds: new Map(), unavailable: new Set()};
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
  // three rounds brought no answer to it
  if (state.unavailable.has(key)) throw new CountinghouseError('ASK_UNAVAILABLE');
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

// ---- the gateway's part: a call's rounds --------------------------------

// The one refusal of a retry's state. Why is for the runtime's own log line
// (`why`, not enumerable: no reply and no result carries it), never for the
// caller, who is told the same whatever failed.
function invalid(why) {
  const e = new CountinghouseError('ASK_STATE_INVALID');
  Object.defineProperty(e, 'why', {value: String(why), enumerable: false});
  return e;
}

// Before the handler runs. -> the call's ask state.
//   modern, capabilities   the request's era and its own declared
//                          capabilities (2026-07-28: per request)
//   questionsOn            --moduleQuestions
//   params                 the request's params: requestState and
//                          inputResponses are read from here only
//   binding                {caller, session, method, tool, arguments}: what
//                          a state is good for (lib/request-state.js)
//   declared(name)         the called action's own question, or null
//   form(pointer, content) the validator's check (lib/module-spec.js
//                          question)
//   key, used              the state's MAC key and the used-nonce store
// Rejects ARGUMENTS_INVALID (an answer given in the arguments),
// ASK_STATE_INVALID (the state is not this call's, has expired or was used:
// one answer for all three) or ASK_STATE_UNCHECKED (the store could not
// say; nothing was used up).
async function begin({modern, capabilities, questionsOn = true, params, binding, declared, form, key, used, now} = {}) {
  // no one to ask: nothing of a retry is read, and no state is used up
  if (modern !== true || questionsOn === false || !declaresForm(capabilities)) return newState({askable: false});
  const args = isObject(binding) ? binding.arguments : null;
  if (isObject(args) && (own(args, 'requestState') || own(args, 'inputResponses'))) {
    throw new CountinghouseError('ARGUMENTS_INVALID', 'an answer to a question is not given in the arguments');
  }
  const state = newState({askable: true});
  const p = isObject(params) ? params : {};
  if (p.requestState === undefined) return state;
  const at = now !== undefined ? {now: now} : undefined;
  const verified = requestState.verify(key, p.requestState, binding, at);
  if (verified.ok !== true) throw invalid(verified.why);
  // what the form was for: "<the question's key>:<its name>", as formOf wrote it
  const cut = verified.question.indexOf(':');
  const asked = {key: cut === -1 ? '' : verified.question.slice(0, cut), name: cut === -1 ? '' : verified.question.slice(cut + 1)};
  if (!QUESTION_KEY.test(asked.key) || !QUESTION_NAME.test(asked.name)) throw invalid('question');
  // single use, before anything of it is acted on. A store that cannot say
  // is neither "first use" nor "used".
  let first;
  try {
    first = await requestState.consume(used, verified, at);
  } catch (e) {
    throw new CountinghouseError('ASK_STATE_UNCHECKED');
  }
  if (first !== true) throw invalid('used');
  // the earlier rounds' answers, entry by entry: a question's key, and an
  // object or null
  for (const k of Object.keys(verified.answers)) {
    const v = verified.answers[k];
    if (QUESTION_KEY.test(k) && (v === null || isObject(v))) state.answers.set(k, v);
  }
  // this round's
  const response = isObject(p.inputResponses) && own(p.inputResponses, RESPONSE_ID) ? p.inputResponses[RESPONSE_ID] : null;
  let answered = false;
  if (isObject(response) && (response.action === 'decline' || response.action === 'cancel')) {
    state.answers.set(asked.key, null);
    answered = true;
  } else if (isObject(response) && response.action === 'accept' && isObject(response.content)) {
    let content = null;
    try {
      const text = JSON.stringify(response.content);
      if (Buffer.byteLength(text, 'utf8') <= requestState.MAX_ANSWERS_BYTES) content = JSON.parse(text);
    } catch (e) { content = null; }
    const question = content != null && typeof(declared) === 'function' ? declared(asked.name) : null;
    if (question != null) {
      let checked = null;
      try { checked = await form(question.schema, content); } catch (e) { checked = null; }
      if (isObject(checked) && checked.valid === true) {
        state.answers.set(asked.key, content);
        answered = true;
      }
    }
  }
  // none: asked again a round on, and after the third no more
  if (!answered) {
    if (verified.round >= MAX_ROUNDS) state.unavailable.add(asked.key);
    else state.rounds.set(asked.key, verified.round);
  }
  return state;
}

// After the handler ended with ASK_PENDING. -> {inputRequests, requestState}
// for the client's InputRequiredResult: one elicitation, a form, with the
// composed text and the question's schema as the validators hold it.
// Rejects ASK_UNAVAILABLE when there is no form to show or no state can be
// made (the earlier answers past their bound): the call then answers that.
async function formOf(state, {binding, form, key, now} = {}) {
  const pending = isState(state) ? state.pending : null;
  if (pending == null) throw new CountinghouseError('ASK_UNAVAILABLE');
  let got = null;
  try { got = await form(pending.schema); } catch (e) { got = null; }
  if (!isObject(got) || !isObject(got.schema)) throw new CountinghouseError('ASK_UNAVAILABLE');
  const answers = {};
  for (const [k, v] of state.answers) if (QUESTION_KEY.test(k)) answers[k] = v;
  const round = (state.rounds.get(pending.key) || 0) + 1;
  let minted;
  try {
    minted = requestState.mint(key, {question: `${pending.key}:${pending.question}`, round: round, answers: answers}, binding,
      now !== undefined ? {now: now} : undefined);
  } catch (e) {
    throw new CountinghouseError('ASK_UNAVAILABLE');
  }
  // round: for the call's usage record, never for the client
  return {inputRequests: {[RESPONSE_ID]: {method: 'elicitation/create', params: {mode: 'form', message: pending.text, requestedSchema: got.schema}}}, requestState: minted, round: round};
}

// What begin and formOf need of the called device, as the main thread holds
// it (the device manager's entry for it): {declared(name), form(pointer,
// content)}. A worker's module: its spec as the main thread built it, and
// the validators. A device on the main thread itself (single-thread mode,
// which isolates nothing): its own spec and schema document, checked here.
function ofDevice(device, serviceID, actionName) {
  const own = device != null && device.moduleSpec != null ? device.moduleSpec : null;
  const spec = own != null ? own.spec : (device != null ? device.spec : null);
  const declared = (name) => questions.declared(spec, serviceID, actionName, name);
  if (own != null) return {declared: declared, form: (pointer, content) => require('./module-spec').question(own, pointer, content)};
  const form = (pointer, content) => new Promise((resolve) => {
    if (device == null || typeof(device.resolveSchemaFromPath) !== 'function') return resolve(null);
    return device.resolveSchemaFromPath(pointer, null, (err, self, data) => {
      if (err != null || !isObject(data)) return resolve({schema: null, valid: null});
      try {
        const schema = JSON.parse(JSON.stringify(data));
        if (content === undefined) return resolve({schema: schema, valid: null});
        const validate = require('./validator').getSchemaValidator().compile(Object.assign({}, schema, {additionalProperties: false}));
        return resolve({schema: schema, valid: validate(content) === true});
      } catch (e) {
        return resolve({failed: String(e != null && e.name).slice(0, 64)});
      }
    });
  });
  return {declared: declared, form: form};
}

module.exports = {answer, decide, newState, begin, formOf, ofDevice, configure, MAX_ROUNDS, RESPONSE_ID};
