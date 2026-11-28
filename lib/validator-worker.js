// A validator worker (lean worker step 1(b), the reviewer's ruling on #152,
// 2026-11-13): a module's input and output are validated here, in a worker
// of a small shared pool (lib/validator-pool.js), never on the main thread,
// which every module and session shares, and never in the module's own
// worker, where its code could switch validation off. No module code ever
// runs here: only the module's api.json and schema.json, as text the main
// thread read, compiled under an ajv of the module's own, lazily, on its
// first check. JSON Schema validation of a module-authored schema cannot be
// bounded by any check made beforehand, so the main thread bounds each
// request by a deadline instead, and replaces this worker when it is missed
// (or when this worker runs out of its memory limit).
//
// Messages from the main thread:
//   {type: 'load', key, name, apiText, schemaText}    a module's files
//   {type: 'forget', key}
//   {type: 'compile', id, key, actions}                 'all', or [[serviceID, actionName]]
//   {type: 'check', id, key, serviceID, actionName, which, args}
//   {type: 'check', ..., buffer}   a hop's result as v8.serialize bytes,
//                                  transferred here; given back on a pass
//                                  (lean worker step 2)
//   {type: 'question', id, key, pointer, content?}     a question's form (ctx.ask,
//                                  lib/module-ask.js): the schema at the
//                                  pointer, and whether content answers it
//   {type: 'safety', id, key}                          lib/schema-safety.js
//   {type: 'devicespec', id, key}                      api.json against spec/schema.json
// Answers: {type: 'answer', id, refused | problem | question | failed}; {type: 'log',
// level, text} for the ajv logger's bounded lines; and {type: 'ready'} once,
// when this worker has loaded.
'use strict';

const {parentPort, workerData} = require('worker_threads');
const options = require('./cli-options');
options.setOptions(Object.assign({}, (workerData != null && workerData.options) || {}, {workerThread: false}));
const LOG = require('./logger');
LOG.createLogger();
const Service = require('./service');
const CHDevice = require('./countinghouse-device');
const validator = require('./validator');
const schemaSafety = require('./schema-safety');
const promptArguments = require('./prompt-arguments');
// loaded here, at boot, with the rest: the safety step runs it (schemaProblem)
require('./declarations');
const {CountinghouseError} = require('./countinghouse-error');
const {decode} = require('./serialized-result');

const modules = new Map();   // key -> {name, apiText, schemaText, built: Promise | null}

// ajv's own log lines (unknown formats, strict-mode notes), bounded: one
// line per module per level, its text cut to 300 characters and JSON-escaped,
// so a module's chosen keys and patterns cannot fill the log or write lines
// of their own (the reviewer, LOW-8).
const LOG_TEXT_MAX = 300;
function boundedLogger(name) {
  const seen = new Set();
  const line = (level) => (...args) => {
    if (seen.has(level)) return;
    seen.add(level);
    let text;
    try {
      text = args.map((a) => (typeof(a) === 'string' ? a : JSON.stringify(a))).join(' ');
    } catch (e) {
      text = '(unrenderable)';
    }
    const escaped = JSON.stringify(String(text).slice(0, LOG_TEXT_MAX));
    parentPort.postMessage({type: 'log', name: String(name), level: level, text: `validator: ${name}: ajv ${level}: ${escaped} (further ${level} lines for this module are not logged)`});
  };
  return {log: () => {}, warn: line('warn'), error: line('error')};
}

// The module's Service objects, built as a worker builds them (the same
// Service code, the same schema resolution: one dereference of the document,
// lib/countinghouse-device.js), but compiled lazily, per action
// (Service.prototype.compileAction): at load for every action (the pool's
// warm compile, under its compile budget), and after this worker replaced
// one, an action at a time as it is called.
// A module's device here: its spec, schema.json and schema validator, made
// once and shared by its services and its prompts (M10).
function deviceOf(key) {
  const m = modules.get(key);
  if (m == null) throw new Error('module not loaded in this validator');
  if (m.device != null) return m.device;
  m.device = {
    spec: JSON.parse(m.apiText),
    schemaDoc: (m.schemaText == null) ? null : JSON.parse(m.schemaText),
    lazySchemas: true,
    schemaValidator: validator.createSchemaValidator({logger: (m.quiet === true) ? {log: () => {}, warn: () => {}, error: () => {}} : boundedLogger(m.name)}),
    resolveSchemaFromPath: CHDevice.prototype.resolveSchemaFromPath
  };
  return m.device;
}

// A module's prompts' arguments, derived and compiled once here (MCP
// completeness M10, lib/prompt-arguments.js): a promise of the Map.
function promptsIn(key) {
  const m = modules.get(key);
  if (m == null) return Promise.reject(new Error('module not loaded in this validator'));
  if (m.prompts == null) {
    // compiled in a schema validator of their own, never the module's: a
    // prompt's schema may be one an action uses, and an $id compiled twice
    // in one ajv is refused (the review of #321), as single-thread mode
    // keeps its own (lib/mcp/prompts.js derivedHere)
    const device = deviceOf(key);
    const own = {spec: device.spec, schemaDoc: device.schemaDoc, resolveSchemaFromPath: device.resolveSchemaFromPath,
      schemaValidator: validator.createSchemaValidator({logger: {log: () => {}, warn: () => {}, error: () => {}}})};
    m.prompts = promptArguments.deriveAll(own);
    // its resource templates' completion candidates (M11), derived with them
    m.resources = promptArguments.deriveResources(own);
    // (read by the load's answer below; a promptArgs that derived it first
    // leaves no rejection unhandled)
    m.resources.catch(() => {});
  }
  return m.prompts;
}

function servicesOf(key) {
  const m = modules.get(key);
  if (m == null) throw new Error('module not loaded in this validator');
  if (m.services != null) return m.services;
  const device = deviceOf(key);
  const spec = device.spec;
  const services = Object.create(null);
  const serviceList = (spec != null && spec.device != null) ? spec.device.serviceList : null;
  for (const serviceID in serviceList) {
    if (!Object.hasOwn(serviceList, serviceID)) continue;
    services[serviceID] = new Service(device, serviceID, serviceList[serviceID]);
  }
  m.services = services;
  return services;
}

// Compiles the actions named ([[serviceID, actionName]]), or every action.
async function compile(key, actions) {
  const services = servicesOf(key);
  const todo = [];
  if (actions === 'all') {
    for (const serviceID of Object.keys(services)) {
      for (const actionName of Object.keys(services[serviceID].actions)) todo.push(services[serviceID].compileAction(actionName));
    }
  } else {
    for (const [serviceID, actionName] of actions) {
      if (Object.hasOwn(services, serviceID)) todo.push(services[serviceID].compileAction(actionName));
    }
  }
  await Promise.all(todo);
  // V8 compiles a function on its first call: ajv's generated validators are
  // run once here, on a value they refuse at once, so a module's first call
  // after a warm-up (or a replacement's) does not pay for that (the review
  // of #165: a call never waits past its own deadline).
  for (const service of Object.values(services)) {
    for (const action of Object.values(service.actions)) {
      for (const k of ['input', 'output', 'fault']) {
        const v = (action[k] != null) ? action[k].validator : null;
        if (typeof(v) === 'function') { try { v(Symbol.for('countinghouse.warm')); } catch (e) { /* only the first call matters */ } }
      }
    }
  }
}

// -> null when the side passes, else {fields, data}: the refusal as a
// worker's reply carries it (CountinghouseError.replyFields).
function asReply(refused) {
  return (refused == null) ? null : {fields: CountinghouseError.replyFields(refused[0]), data: refused[1]};
}

async function check(msg) {
  const services = servicesOf(msg.key);
  const service = Object.hasOwn(services, msg.serviceID) ? services[msg.serviceID] : null;
  if (service == null) return asReply([new CountinghouseError('SERVICE_NOT_FOUND', msg.serviceID), null]);
  if (!Object.hasOwn(service.actions, msg.actionName)) return asReply([new CountinghouseError('ACTION_NOT_FOUND', msg.actionName), null]);
  await service.compileAction(msg.actionName);
  // bytes that do not deserialise fail the check (fail closed): the
  // answering worker made them, and a module there can post its own
  let args;
  try {
    args = (msg.buffer instanceof ArrayBuffer) ? decode(msg.buffer) : msg.args;
  } catch (e) {
    // a hop's input says so (the review of #185); a result's keeps its text
    if (msg.which === 'input') return asReply([CountinghouseError.runtimeReason('DEVICE_INVOKE_EXCEPTION', 'a hop\'s input could not be read'), null]);
    throw e;
  }
  if (msg.which === 'input') return asReply(service.refuseCall(msg.actionName, args, false, true));
  return asReply(service.refuseData(service.actions[msg.actionName], args, false));
}

// A question's form (the MCP completeness design, section 8): the schema
// `pointer` names in the module's schema.json, and, when `content` is given,
// whether it is an answer to it. An answer holds the form's own properties
// and no other, whatever the form says of additional ones. The form is flat
// and bounded (lib/declarations.js checked it at load), so this is one
// small compile, kept per pointer.
const MAX_QUESTION_FORMS = 64;
async function question(msg) {
  deviceOf(msg.key);   // its schema.json and validator (kept on the module, M10)
  const m = modules.get(msg.key);
  if (typeof(msg.pointer) !== 'string' || msg.pointer === '' || m.device.schemaDoc == null) return {schema: null, valid: null};
  const found = await new Promise((resolve) => m.device.resolveSchemaFromPath(msg.pointer, null, (err, self, data) => resolve(err != null ? null : data)));
  if (found == null || typeof(found) !== 'object' || Array.isArray(found)) return {schema: null, valid: null};
  const schema = JSON.parse(JSON.stringify(found));
  if (!Object.hasOwn(msg, 'content')) return {schema: schema, valid: null};
  if (m.forms == null) m.forms = new Map();
  let validate = m.forms.get(msg.pointer);
  if (validate == null) {
    // the form's own rules, without what only a client reads (enumNames)
    validate = m.device.schemaValidator.compile(require('./module-questions').answerSchema(schema));
    if (m.forms.size >= MAX_QUESTION_FORMS) m.forms.clear();
    m.forms.set(msg.pointer, validate);
  }
  return {schema: schema, valid: validate(msg.content) === true};
}

parentPort.on('message', (msg) => {
  if (msg == null) return;
  if (msg.type === 'question') {
    let pending;
    try { pending = question(msg); } catch (e) { pending = Promise.reject(e); }
    pending.then((answer) => parentPort.postMessage({type: 'answer', id: msg.id, question: answer}),
      (e) => parentPort.postMessage({type: 'answer', id: msg.id, failed: (e != null && e.name) || 'Error'}));
    return;
  }
  if (msg.type === 'load') {
    modules.set(msg.key, {name: msg.name, apiText: msg.apiText, schemaText: msg.schemaText, services: null});
    return;
  }
  if (msg.type === 'forget') {
    modules.delete(msg.key);
    return;
  }
  if (msg.type === 'safety') {
    const m = modules.get(msg.key);
    let verdict = {problem: null, hiddenUnlisted: []};
    try {
      let spec = null;
      try { spec = JSON.parse(m.apiText); } catch (e) { spec = null; }
      // a module with no schema.json too: what it declares is checked all the
      // same; and the tools its declared text leaves unusable (#400)
      if (m != null) verdict = schemaSafety.schemaVerdict(m.schemaText == null ? null : m.schemaText, spec);
    } catch (e) {
      return parentPort.postMessage({type: 'answer', id: msg.id, failed: e.name});
    }
    return parentPort.postMessage({type: 'answer', id: msg.id, problem: verdict.problem, hiddenUnlisted: verdict.hiddenUnlisted});
  }
  // api.json against the device spec's own schema (lib/module-spec.js
  // deviceSpec), here, off the main thread.
  if (msg.type === 'devicespec') {
    const m = modules.get(msg.key);
    let specError = null;
    try {
      const spec = JSON.parse(m.apiText);
      validator.validateDeviceSpec(spec, (err) => {
        if (err != null) {
          specError = {message: String(err.message).slice(0, 2000),
            validationErrors: (Array.isArray(err.validationErrors) ? err.validationErrors : []).slice(0, 50)
              .map((e) => ({instancePath: String(e.instancePath), message: String(e.message)}))};
        }
      });
    } catch (e) {
      return parentPort.postMessage({type: 'answer', id: msg.id, failed: e.name});
    }
    return parentPort.postMessage({type: 'answer', id: msg.id, specError: specError});
  }
  if (msg.type === 'compile') {
    let pending;
    try { pending = compile(msg.key, msg.actions); } catch (e) { pending = Promise.reject(e); }
    pending.then(() => parentPort.postMessage({type: 'answer', id: msg.id, compiled: true}),
      (e) => parentPort.postMessage({type: 'answer', id: msg.id, failed: (e != null && e.name) || 'Error'}));
    return;
  }
  // M10: a module's prompts' arguments, at load (derived and compiled), and
  // one prompts/get's arguments checked
  if (msg.type === 'prompts') {
    let pending;
    try { pending = promptsIn(msg.key); } catch (e) { pending = Promise.reject(e); }
    pending.then((derived) => modules.get(msg.key).resources.then((resources) => ({derived, resources})))
      .then(({derived, resources}) => parentPort.postMessage({type: 'answer', id: msg.id,
        prompts: promptArguments.listed(derived), completions: promptArguments.completions(derived), resourceCompletions: resources}),
      (e) => parentPort.postMessage({type: 'answer', id: msg.id, failed: String(e != null && e.message != null ? e.message : 'Error').slice(0, 300)}));
    return;
  }
  if (msg.type === 'promptArgs') {
    let pending;
    try { pending = promptsIn(msg.key); } catch (e) { pending = Promise.reject(e); }
    pending.then((derived) => parentPort.postMessage({type: 'answer', id: msg.id, errors: promptArguments.check(derived.get(msg.prompt), msg.args)}),
      (e) => parentPort.postMessage({type: 'answer', id: msg.id, failed: String(e != null && e.name != null ? e.name : 'Error').slice(0, 64)}));
    return;
  }
  if (msg.type === 'check') {
    let pending;
    try { pending = check(msg); } catch (e) { pending = Promise.reject(e); }
    pending.then((refused) => {
      // a pass gives a serialized value's bytes back, transferred
      if (refused == null && msg.buffer instanceof ArrayBuffer) return parentPort.postMessage({type: 'answer', id: msg.id, refused: null, buffer: msg.buffer}, [msg.buffer]);
      parentPort.postMessage({type: 'answer', id: msg.id, refused: refused});
    },
      (e) => parentPort.postMessage({type: 'answer', id: msg.id, failed: (e != null && e.name) || 'Error'}));
  }
});

// Primed, then ready. A validator compiles a module where its checks
// first land (its home, or where one spilled, or the spare that took a
// failed validator's place), so the first load, compile and check in this
// isolate (the schema resolution, ajv's code, V8's first compile of each)
// is paid here, once, on a module of its own, not on a module's first call
// (module-loading 24: a replaced validator's place is taken at once, and
// another module still checks in under 50 ms). Then forgotten.
const PRIME = '\u0000prime';
const PRIME_SERVICE = 'urn:countinghouse:serviceID:prime';
(async () => {
  try {
    // quiet: ajv's lines about it are not the operator's, nor a module's
    modules.set(PRIME, {name: 'prime', quiet: true, services: null,
      apiText: JSON.stringify({device: {friendlyName: 'prime', serviceList: {[PRIME_SERVICE]: {actionList: [{name: 'a', input: {schema: '/p/a/input'}, output: {schema: '/p/a/output'}}]}}}}),
      schemaText: JSON.stringify({$id: '#/', p: {a: {input: {type: 'object', properties: {n: {type: 'integer'}}}, output: {type: 'object'}}}})});
    await compile(PRIME, 'all');
    await check({key: PRIME, serviceID: PRIME_SERVICE, actionName: 'a', which: 'input', args: {input: {n: 1}}});
  } catch (e) {
    // a prime that fails costs a module's first call its time, nothing else;
    // said once, so a slow first check is explained
    parentPort.postMessage({type: 'log', name: '(validator start)', level: 'warn',
      text: `validator: priming this validator failed (${String(e && e.name).slice(0, 64)}): a module's first compile here pays its first-use cost`});
  } finally {
    modules.delete(PRIME);
  }
  // Loaded: requests may come (the pool's deadlines start from here on).
  parentPort.postMessage({type: 'ready'});
})();
