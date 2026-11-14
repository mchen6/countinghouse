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
//   {type: 'check', id, key, serviceID, actionName, which, args}
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
    parentPort.postMessage({type: 'log', level: level, text: `validator: ${name}: ajv ${level}: ${escaped} (further ${level} lines for this module are not logged)`});
  };
  return {log: () => {}, warn: line('warn'), error: line('error')};
}

// The module's Service objects, built as a worker builds them (the same
// schema resolution and Service code), once every action's schemas are
// resolved and compiled.
function servicesOf(key) {
  const m = modules.get(key);
  if (m == null) return Promise.reject(new Error('module not loaded in this validator'));
  if (m.built != null) return m.built;
  m.built = new Promise((resolve, reject) => {
    let pending = 0;
    let built = false;
    let services = null;
    const maybeDone = () => { if (built && pending === 0) resolve(services); };
    try {
      const spec = JSON.parse(m.apiText);
      const schemaDoc = (m.schemaText == null) ? null : JSON.parse(m.schemaText);
      const device = {
        spec: spec,
        schemaDoc: schemaDoc,
        schemaValidator: validator.createSchemaValidator({logger: boundedLogger(m.name)}),
        resolveSchemaFromPath: function(pointer, self, callback) {
          pending++;
          let answered = false;
          CHDevice.prototype.resolveSchemaFromPath.call(this, pointer, self, (...answer) => {
            if (answered) return;
            answered = true;
            try {
              callback(...answer);
            } finally {
              pending--;
              maybeDone();
            }
          });
        }
      };
      services = Object.create(null);
      const serviceList = (spec != null && spec.device != null) ? spec.device.serviceList : null;
      for (const serviceID in serviceList) {
        if (!Object.hasOwn(serviceList, serviceID)) continue;
        services[serviceID] = new Service(device, serviceID, serviceList[serviceID]);
      }
    } catch (e) {
      return reject(e);
    }
    built = true;
    maybeDone();
  });
  return m.built;
}

// -> null when the side passes, else {fields, data}: the refusal as a
// worker's reply carries it (CountinghouseError.replyFields).
function asReply(refused) {
  return (refused == null) ? null : {fields: CountinghouseError.replyFields(refused[0]), data: refused[1]};
}

async function check(msg) {
  const services = await servicesOf(msg.key);
  const service = Object.hasOwn(services, msg.serviceID) ? services[msg.serviceID] : null;
  if (service == null) return asReply([new CountinghouseError('SERVICE_NOT_FOUND', msg.serviceID), null]);
  if (msg.which === 'input') return asReply(service.refuseCall(msg.actionName, msg.args, false, true));
  if (!Object.hasOwn(service.actions, msg.actionName)) return asReply([new CountinghouseError('ACTION_NOT_FOUND', msg.actionName), null]);
  return asReply(service.refuseData(service.actions[msg.actionName], msg.args, false));
}

parentPort.on('message', (msg) => {
  if (msg == null) return;
  if (msg.type === 'load') {
    modules.set(msg.key, {name: msg.name, apiText: msg.apiText, schemaText: msg.schemaText, built: null});
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
  if (msg.type === 'check') {
    check(msg).then((refused) => parentPort.postMessage({type: 'answer', id: msg.id, refused: refused}),
      (e) => parentPort.postMessage({type: 'answer', id: msg.id, failed: (e != null && e.name) || 'Error'}));
  }
});

// Loaded: requests may come (the pool's deadlines start from here on).
parentPort.postMessage({type: 'ready'});
