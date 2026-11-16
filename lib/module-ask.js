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
// Over composition (M14) the asker may be a part, reached by a hop: its
// token has its own action, and the call's ONE ask state is on the outer
// call's token, found by the chain. So a part's question goes to the outer
// call's user, counts in the call's rounds, and is one of the part's own.
//
// A call's ask state is made by whoever starts the call (the gateway):
//
//   {askable, answers: Map(key -> content | null), pending, rounds,
//    unavailable, callRounds, shownAs}
//
//   askable       whether this call has someone to ask (a modern request
//                 that declared form elicitation, module questions on, not
//                 a task)
//   answers       what this run may use, by the question's key
//                 (lib/module-questions.js keyOf): a validated content
//                 object, or null for a decline
//   pending       the question this run asked that has no answer, as the
//                 gateway needs it for its form: {key, question, text,
//                 schema, asker: {deviceID, serviceID, actionName}}
//   rounds        key -> the rounds a question has had with no answer
//   unavailable   the keys whose three rounds brought none: asked again,
//                 such a question is ASK_UNAVAILABLE
//   callRounds    the rounds this call has had so far, every question's
//                 together: after eight, no question is asked
//   shownAs       the name every dialog of this call carries: the called,
//                 LISTED module's. A part is unlisted, and is never named
//                 to the client (the reviewer's ruling, 2026-11-16); the
//                 runtime's log and usage record name who really asked.
//                 null: the asker's own name (a call no gateway began)
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
// a question's rounds with no answer
const MAX_ROUNDS = 3;
// A call's rounds in all, any mix of questions (the reviewer's I1 on #311).
// A question's own round travels only while it is the one asked, and its
// key is of its text: a handler whose text differs on every pass (a time in
// its values) asks a first round each time. The call's count is what stops
// it: a pass that asks is not billed, so a call may not ask for ever. It
// also bounds what a call can settle: eight questions at most.
const MAX_CALL_ROUNDS = 8;
// the one request of an input_required answer, and its response's key
const RESPONSE_ID = 'answer';
const QUESTION_KEY = /^[A-Za-z0-9_-]{43}$/;
const QUESTION_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const deps = {};
function configure(given = {}) {
  Object.assign(deps, {
    resolve: (token, workerId) => require('./call-tokens').resolve(token, {workerId: workerId}),
    outerOf: (entry) => require('./call-tokens').outerOf(entry),
    // the module's api.json as the main thread holds it, or null
    specOf: () => null
  }, given);
}
configure();

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isState = (s) => isObject(s) && typeof(s.askable) === 'boolean' && s.answers instanceof Map && own(s, 'pending') && s.rounds instanceof Map && s.unavailable instanceof Set
  && Number.isInteger(s.callRounds) && s.callRounds >= 0 && (s.shownAs === null || typeof(s.shownAs) === 'string');

// A call's ask state. Anything but a true `askable` and a Map of answers is
// "no one to ask" and "no answers".
function newState({askable = false, answers = null, shownAs = null} = {}) {
  return {askable: askable === true, answers: answers instanceof Map ? answers : new Map(), pending: null, rounds: new Map(), unavailable: new Set(), callRounds: 0,
    shownAs: (typeof(shownAs) === 'string' && shownAs !== '') ? shownAs : null};
}

// The decision, for an ask whose context is known: {state, module,
// deviceID, serviceID, actionName, spec}: the CALL's state, and who asks
// (its module's name and api.json as the main thread holds them, its
// device and its action). A worker's ask comes to it through its token (answer);
// in single-thread mode, which has no tokens, the context rides on the
// call's args (lib/handler-ctx.js attachAsk).
function decide(context, name, values) {
  const c = isObject(context) ? context : {};
  if (!isState(c.state) || c.state.askable !== true) throw new CountinghouseError('ASK_UNAVAILABLE');
  // the dialog names who asks: with no name there is no one to put it to
  if (typeof(c.module) !== 'string' || c.module === '') throw new CountinghouseError('ASK_UNAVAILABLE');
  // who asks is known, or no one is asked: the retry's answer is checked
  // against the asker's own form
  if (typeof(c.deviceID) !== 'string' || c.deviceID === '' || typeof(c.serviceID) !== 'string' || typeof(c.actionName) !== 'string') throw new CountinghouseError('ASK_UNAVAILABLE');
  const state = c.state;
  if (typeof(name) !== 'string' || name.length > MAX_NAME_CHARS) throw new CountinghouseError('ASK_NOT_DECLARED');
  const declared = questions.declared(c.spec, c.serviceID, c.actionName, name);
  if (declared == null) throw new CountinghouseError('ASK_NOT_DECLARED');
  // (throws ASK_NOT_DECLARED for a value the message cannot say)
  // under the call's listed module's name; the key is of who asks
  const text = questions.composed(state.shownAs != null ? state.shownAs : String(c.module), declared.message, values);
  const key = questions.keyOf({module: String(c.module), serviceID: c.serviceID, action: c.actionName, question: name, text: text});
  if (state.answers.has(key)) {
    const content = state.answers.get(key);
    // the handler's own copy
    return content == null ? null : structuredClone(content);
  }
  // three rounds brought no answer to it
  if (state.unavailable.has(key)) throw new CountinghouseError('ASK_UNAVAILABLE');
  // one question a round: the first that has no answer is the one asked,
  // within the rounds a call may have
  if (state.pending == null) {
    if (state.callRounds >= MAX_CALL_ROUNDS) throw new CountinghouseError('ASK_UNAVAILABLE');
    state.pending = {key: key, question: name, text: text, schema: declared.schema, asker: {deviceID: c.deviceID, serviceID: c.serviceID, actionName: c.actionName}};
  }
  throw new CountinghouseError('ASK_PENDING');
}

// A worker's ask. spec and moduleName: its own module's api.json and name,
// as the main thread holds them (the worker's listener does); else
// deps.specOf(entry) and the token's (which names none before the module's
// composition binding).
function answer(data, workerId, spec, moduleName) {
  if (!isObject(data) || typeof(data.token) !== 'string') throw new CountinghouseError('CALL_TOKEN_INVALID');
  const entry = deps.resolve(data.token, workerId);
  if (entry == null) throw new CountinghouseError('CALL_TOKEN_INVALID');
  // the call's state is the outer call's, whichever token of its chain
  // asks (M14); who asks is this token's own device and action
  const outer = deps.outerOf(entry);
  return decide({state: outer != null ? outer.ask : null, module: typeof(moduleName) === 'string' ? moduleName : entry.module, deviceID: entry.deviceID, serviceID: entry.serviceID, actionName: entry.actionName,
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
//   asks                   whether the call can end on a question: the
//                          called action declares one, or an action it
//                          can reach through declared calls does
//   shownAs                the called, listed module's name: what every
//                          dialog of the call carries
//   ofAsker(asker)         who asked, as the main thread holds it NOW:
//                          {declared(name), form(pointer, content)} of the
//                          device and action {deviceID, serviceID,
//                          actionName}, or null when it is gone (ofDevice,
//                          below). The asker is the outer call's own
//                          action or a part's (M14)
//   key, used              the state's MAC key and the used-nonce store,
//                          or a function that gives each: reached only for
//                          a state (a call that carries none, and one no
//                          one can be asked, touch neither)
// Rejects ARGUMENTS_INVALID (an answer given in the arguments),
// ASK_STATE_INVALID (the state is not this call's, has expired or was used:
// one answer for all three) or ASK_STATE_UNCHECKED (the store could not
// say: nothing ran, and the state may or may not count as used by now, since
// a store that timed out may still have recorded it).
const given = (v) => (typeof(v) === 'function' ? v() : v);

async function begin({modern, capabilities, questionsOn = true, asks = true, shownAs = null, params, binding, ofAsker, key, used, now} = {}) {
  // no one to ask: nothing of a retry is read, and no state is used up
  if (modern !== true || questionsOn === false || !declaresForm(capabilities)) return newState({askable: false});
  // a call that can end on a question never takes its answer from its
  // arguments; one that cannot may have an input of either name. (asks: a
  // value, or a function asked only here, where someone can be asked)
  const args = isObject(binding) ? binding.arguments : null;
  if (isObject(args) && (own(args, 'requestState') || own(args, 'inputResponses')) && given(asks) === true) {
    throw new CountinghouseError('ARGUMENTS_INVALID', 'an answer to a question is not given in the arguments');
  }
  const state = newState({askable: true, shownAs: shownAs});
  const p = isObject(params) ? params : {};
  if (p.requestState === undefined) return state;
  const at = now !== undefined ? {now: now} : undefined;
  // a key or a store that cannot be had now: the state could not be checked
  let macKey;
  let usedStore;
  try {
    macKey = given(key);
    usedStore = given(used);
  } catch (e) {
    throw new CountinghouseError('ASK_STATE_UNCHECKED');
  }
  const verified = requestState.verify(macKey, p.requestState, binding, at);
  if (verified.ok !== true) throw invalid(verified.why);
  // what the form was for, and who asked, as formOf wrote it
  const asked = askedOf(verified.question);
  if (asked == null) throw invalid('question');
  // single use, before anything of it is acted on. A store that cannot say
  // is neither "first use" nor "used".
  let first;
  try {
    first = await requestState.consume(usedStore, verified, at);
  } catch (e) {
    throw new CountinghouseError('ASK_STATE_UNCHECKED');
  }
  if (first !== true) throw invalid('used');
  // the rounds the call has had, this state's among them
  state.callRounds = verified.callRound;
  // the earlier rounds' answers, entry by entry: a question's key, and an
  // object or null; false is a question three rounds settled as unanswered
  for (const k of Object.keys(verified.answers)) {
    const v = verified.answers[k];
    if (!QUESTION_KEY.test(k)) continue;
    if (v === null || isObject(v)) state.answers.set(k, v);
    else if (v === false) state.unavailable.add(k);
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
    // the asker's own declaration and validators, as they stand now: gone,
    // or no longer declaring it, and the answer is none
    let of = null;
    try { of = content != null && typeof(ofAsker) === 'function' ? ofAsker(asked.asker) : null; } catch (e) { of = null; }
    const question = isObject(of) && typeof(of.declared) === 'function' ? of.declared(asked.name) : null;
    if (question != null && typeof(of.form) === 'function') {
      let checked = null;
      try { checked = await of.form(question.schema, content); } catch (e) { checked = null; }
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

// What a state made for this call is bound to: the arguments as the client
// sent them, kept apart from the object the handler is given (in
// single-thread mode that is the same object, and a handler may change it
// before it asks). Copied only where a state can be made: a call that can
// be asked, of an action that declares a question. Any other call pays
// nothing for it.
function bindingArguments({state, asks, arguments: args} = {}) {
  if (!isState(state) || state.askable !== true || given(asks) !== true) return args;
  return JSON.parse(JSON.stringify(args));
}

// Whether a call of `from` ({deviceID, serviceID, actionName}) can end on a
// question (M14; the reviewer's ruling, 2026-11-16): its own action
// declares one, or an action it can reach through the modules' verified
// declared calls does. A module's calls are its own, whichever of its
// actions makes them, so from an action the walk goes to every target its
// module declared, and from each target to its module's.
//   asksAt(target)    whether that action declares any question
//   callsOf(deviceID) the targets that module's verified declarations name
//                     ([{deviceID, serviceID, actionName}])
// Each module's calls are read once (modules that call each other end the
// walk). BOUNDED: at most MAX_REACH modules are read and MAX_REACH * 8
// targets looked at; past either, or when a lookup throws, the answer is
// yes. That errs to the stricter side: such a call copies its arguments
// and refuses an answer in them, and is never asked a question no action
// declared.
const MAX_REACH = 64;
function canAsk(from, {asksAt, callsOf} = {}) {
  try {
    if (asksAt(from) === true) return true;
    const read = new Set();
    const queue = [from.deviceID];
    let looked = 0;
    while (queue.length > 0) {
      const deviceID = queue.shift();
      if (read.has(deviceID)) continue;
      if (read.size >= MAX_REACH) return true;
      read.add(deviceID);
      const targets = callsOf(deviceID);
      for (const target of Array.isArray(targets) ? targets : []) {
        if (!isObject(target) || typeof(target.deviceID) !== 'string') continue;
        looked += 1;
        if (looked > MAX_REACH * 8) return true;
        if (asksAt(target) === true) return true;
        if (!read.has(target.deviceID)) queue.push(target.deviceID);
      }
    }
    return false;
  } catch (e) {
    return true;
  }
}

// What a state says its form was for: the question's key and name, and who
// asked (a device, a service, an action), as one JSON array under the
// state's MAC. The retry's answer is checked against that asker's form.
const MAX_ASKER_CHARS = 256;
const askerText = (s) => typeof(s) === 'string' && s !== '' && s.length <= MAX_ASKER_CHARS;
function questionOf(pending) {
  return JSON.stringify([pending.key, pending.question, pending.asker.deviceID, pending.asker.serviceID, pending.asker.actionName]);
}
// -> {key, name, asker: {deviceID, serviceID, actionName}}, or null for
// anything that is not exactly that
function askedOf(text) {
  let q = null;
  try { q = JSON.parse(text); } catch (e) { return null; }
  if (!Array.isArray(q) || q.length !== 5 || !q.every((s) => typeof(s) === 'string')) return null;
  const [key, name, deviceID, serviceID, actionName] = q;
  if (!QUESTION_KEY.test(key) || !QUESTION_NAME.test(name) || !askerText(deviceID) || !askerText(serviceID) || !askerText(actionName)) return null;
  return {key: key, name: name, asker: {deviceID: deviceID, serviceID: serviceID, actionName: actionName}};
}

// After the handler ended with ASK_PENDING. -> {inputRequests, requestState}
// for the client's InputRequiredResult: one elicitation, a form, with the
// composed text and the question's schema as the validators hold it.
// Rejects ASK_UNAVAILABLE when there is no form to show or no state can be
// made (the earlier answers past their bound): the call then answers that.
async function formOf(state, {binding, ofAsker, key, now} = {}) {
  const pending = isState(state) ? state.pending : null;
  if (pending == null || !isObject(pending.asker)) throw new CountinghouseError('ASK_UNAVAILABLE');
  // the form is the asker's own, from its validators
  let got = null;
  try {
    const of = typeof(ofAsker) === 'function' ? ofAsker(pending.asker) : null;
    got = isObject(of) && typeof(of.form) === 'function' ? await of.form(pending.schema) : null;
  } catch (e) { got = null; }
  if (!isObject(got) || !isObject(got.schema)) throw new CountinghouseError('ASK_UNAVAILABLE');
  // what the call has settled so far rides in the state: its answers, and
  // (as false) the questions three rounds left unanswered
  const answers = {};
  for (const [k, v] of state.answers) if (QUESTION_KEY.test(k)) answers[k] = v;
  for (const k of state.unavailable) if (QUESTION_KEY.test(k)) answers[k] = false;
  const round = (state.rounds.get(pending.key) || 0) + 1;
  // the call's: one more than it has had (decide asks nothing past the last)
  const callRound = state.callRounds + 1;
  if (callRound > MAX_CALL_ROUNDS) throw new CountinghouseError('ASK_UNAVAILABLE');
  let minted;
  try {
    minted = requestState.mint(given(key), {question: questionOf(pending), round: round, callRound: callRound, answers: answers}, binding,
      now !== undefined ? {now: now} : undefined);
  } catch (e) {
    throw new CountinghouseError('ASK_UNAVAILABLE');
  }
  // round: the call's, for its usage record (how late in the call the module
  // asked), never for the client
  return {inputRequests: {[RESPONSE_ID]: {method: 'elicitation/create', params: {mode: 'form', message: pending.text, requestedSchema: got.schema}}}, requestState: minted, round: callRound};
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
  const asks = questions.asks(spec, serviceID, actionName);
  if (own != null) return {asks: asks, declared: declared, form: (pointer, content) => require('./module-spec').question(own, pointer, content)};
  const form = (pointer, content) => new Promise((resolve) => {
    if (device == null || typeof(device.resolveSchemaFromPath) !== 'function') return resolve(null);
    return device.resolveSchemaFromPath(pointer, null, (err, self, data) => {
      if (err != null || !isObject(data)) return resolve({schema: null, valid: null});
      try {
        const schema = JSON.parse(JSON.stringify(data));
        if (content === undefined) return resolve({schema: schema, valid: null});
        // compiled once per device and pointer (ajv keeps what it compiles)
        if (!compiledForms.has(device)) compiledForms.set(device, new Map());
        const kept = compiledForms.get(device);
        let validate = kept.get(pointer);
        if (validate == null) {
          validate = require('./validator').getSchemaValidator().compile(questions.answerSchema(schema));
          if (kept.size >= 64) kept.clear();
          kept.set(pointer, validate);
        }
        return resolve({schema: schema, valid: validate(content) === true});
      } catch (e) {
        return resolve({failed: String(e != null && e.name).slice(0, 64)});
      }
    });
  });
  return {asks: asks, declared: declared, form: form};
}
// a main-thread device's compiled forms: device -> Map(pointer -> validator)
const compiledForms = new WeakMap();

module.exports = {answer, decide, newState, begin, formOf, bindingArguments, canAsk, ofDevice, configure, MAX_ROUNDS, MAX_CALL_ROUNDS, MAX_REACH, RESPONSE_ID};
