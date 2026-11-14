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
//   {type: 'safety', id, key}                          lib/schema-safety.js
// Answers: {type: 'answer', id, refused | problem | failed}; {type: 'log',
// level, text} for the ajv logger's bounded lines; and {type: 'ready'} once,
// when this worker has loaded.
'use strict';

const {parentPort, workerData} = require('worker_threads');
const options = require('./cli-options');
options.setOptions(Object.assign({}, (workerData != null && workerData.options) || {}, {workerThread: false}));
const LOG = require('./logger');
LOG.createLogger(false);
const Service = require('./service');
const CHDevice = require('./countinghouse-device');
const validator = require('./validator');
const schemaSafety = require('./schema-safety');
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
function servicesOf(key) {
  const m = modules.get(key);
  if (m == null) throw new Error('module not loaded in this validator');
  if (m.services != null) return m.services;
  const spec = JSON.parse(m.apiText);
  const schemaDoc = (m.schemaText == null) ? null : JSON.parse(m.schemaText);
  const device = {
    spec: spec,
    schemaDoc: schemaDoc,
    lazySchemas: true,
    schemaValidator: validator.createSchemaValidator({logger: boundedLogger(m.name)}),
    resolveSchemaFromPath: CHDevice.prototype.resolveSchemaFromPath
  };
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
  const args = (msg.buffer instanceof ArrayBuffer) ? decode(msg.buffer) : msg.args;
  if (msg.which === 'input') return asReply(service.refuseCall(msg.actionName, args, false, true));
  return asReply(service.refuseData(service.actions[msg.actionName], args, false));
}

parentPort.on('message', (msg) => {
  if (msg == null) return;
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
    let problem = null;
    try {
      let spec = null;
      try { spec = JSON.parse(m.apiText); } catch (e) { spec = null; }
      problem = (m == null || m.schemaText == null) ? null : schemaSafety.schemaProblem(m.schemaText, spec);
    } catch (e) {
      return parentPort.postMessage({type: 'answer', id: msg.id, failed: e.name});
    }
    return parentPort.postMessage({type: 'answer', id: msg.id, problem: problem});
  }
  if (msg.type === 'compile') {
    let pending;
    try { pending = compile(msg.key, msg.actions); } catch (e) { pending = Promise.reject(e); }
    pending.then(() => parentPort.postMessage({type: 'answer', id: msg.id, compiled: true}),
      (e) => parentPort.postMessage({type: 'answer', id: msg.id, failed: (e != null && e.name) || 'Error'}));
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

// Loaded: requests may come (the pool's deadlines start from here on).
parentPort.postMessage({type: 'ready'});
