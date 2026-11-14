// The validator pool (lean worker step 1(b), the reviewer's ruling on #152,
// 2026-11-13): a module's input and output are validated in one of a few
// shared validator workers (lib/validator-worker.js), never on the main
// thread and never in the module's own worker.
//
// - The pool is --validatorWorkers workers (default 2), each with resource
//   limits, started on first use. A worker takes one request at a time, so a
//   request's deadline counts its own work only, never a queue's.
// - A request's deadline is --validationTimeoutMs (default 1000) from when
//   it is sent. Missed, or the worker ending (a crash, its memory limit), the
//   worker is replaced and the call is refused VALIDATION_TIMEOUT, which names
//   the module, the action and the side, never a key or a value; and logged.
//   Compiling a module's schemas happens in its first request, under the same
//   deadline.
// - A circuit breaker: a module that misses the deadline 3 times in 5 minutes
//   is quarantined, its calls refused VALIDATION_QUARANTINED (logged) until
//   it is loaded again (a new spec, a new key). One module must not keep
//   replacing the shared pool's workers.
// - The value checked is the structured clone posted to the worker: exactly
//   what the module's worker receives (a class instance arrives as its
//   fields there too).
'use strict';

const path = require('path');
const {Worker} = require('worker_threads');
const options = require('./cli-options');
const LOG = require('./logger');
const {CountinghouseError} = require('./countinghouse-error');

const WORKER_FILE = path.join(__dirname, 'validator-worker.js');
const RESOURCE_LIMITS = {maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4};
const STRIKES = 3;
const STRIKE_WINDOW_MS = 5 * 60 * 1000;

const ZH_WHICH = {input: '输入', output: '输出'};

// A refusal made here, decoded as a worker's reply is (replyFields, then
// fromReplyFields), so every caller sees it as it sees any other.
const asReply = (err, data = null) => [CountinghouseError.fromReplyFields(CountinghouseError.replyFields(err)), data];

function ValidatorPool(opts) {
  const o = opts || {};
  this.size = Number.isInteger(o.size) && o.size > 0 ? o.size : 2;
  this.timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : 1000;
  this.workerOptions = o.workerOptions || {};
  this.modules = new Map();      // key -> {name, apiText, schemaText}
  this.strikes = new Map();      // key -> [times]
  this.quarantined = new Set();
  this.queue = [];
  this.nextId = 1;
  this.slots = [];
  for (let i = 0; i < this.size; i++) this.slots.push(this.spawn());
}

ValidatorPool.prototype.spawn = function() {
  // A worker takes requests once it says it is ready: its start is not any
  // request's time.
  const slot = {worker: null, loaded: new Set(), current: null, ending: false, ready: false};
  const worker = new Worker(WORKER_FILE, {workerData: {options: this.workerOptions}, resourceLimits: RESOURCE_LIMITS});
  worker.unref();
  slot.worker = worker;
  worker.on('message', (msg) => this.onMessage(slot, msg));
  // A worker that ends on its own (a crash, its memory limit) fails the
  // request it held, as a missed deadline does.
  const ended = (why) => {
    if (slot.ending) return;
    this.fail(slot, why);
  };
  worker.on('error', (e) => ended(e != null && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'its memory limit' : 'a crash'));
  worker.on('exit', () => ended('an exit'));
  return slot;
};

// Registers a module's files under `key` (one per start of the module); sent
// to a worker on its first request there.
ValidatorPool.prototype.register = function(key, name, apiText, schemaText) {
  this.modules.set(key, {name: name, apiText: apiText, schemaText: schemaText});
};

ValidatorPool.prototype.forget = function(key) {
  this.modules.delete(key);
  this.strikes.delete(key);
  this.quarantined.delete(key);
  for (const slot of this.slots) {
    if (slot.loaded.delete(key)) slot.worker.postMessage({type: 'forget', key: key});
  }
};

ValidatorPool.prototype.isQuarantined = function(key) {
  return this.quarantined.has(key);
};

// -> Promise of null (the side passes) or [error, data], the call's answer.
ValidatorPool.prototype.check = function(key, serviceID, actionName, which, args) {
  const m = this.modules.get(key);
  if (m == null) return Promise.resolve(asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the module\'s validation is not loaded')));
  if (this.quarantined.has(key)) {
    return Promise.resolve(asReply(CountinghouseError.withFields('VALIDATION_QUARANTINED', {module: m.name})));
  }
  return this.request(key, {type: 'check', key: key, serviceID: serviceID, actionName: actionName, which: which, args: args},
    {module: m.name, action: actionName, which: which});
};

// -> Promise of null, a schema-safety problem ({path, reason}), or
// {timeout: error}: the load-time courtesy check, run in a validator.
ValidatorPool.prototype.safety = function(key) {
  const m = this.modules.get(key);
  if (m == null) return Promise.resolve(null);
  return this.request(key, {type: 'safety', key: key}, {module: m.name, action: '(schema.json)', which: 'input', safety: true});
};

ValidatorPool.prototype.request = function(key, msg, meta) {
  return new Promise((resolve) => {
    this.queue.push({key: key, msg: Object.assign({id: this.nextId++}, msg), meta: meta, resolve: resolve});
    this.dispatch();
  });
};

ValidatorPool.prototype.dispatch = function() {
  for (const slot of this.slots) {
    if (this.queue.length === 0) return;
    if (slot.current != null || slot.ending || !slot.ready) continue;
    const req = this.queue.shift();
    const m = this.modules.get(req.key);
    if (m == null) {
      req.resolve(req.meta.safety ? null : asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the module\'s validation is not loaded')));
      continue;
    }
    if (this.quarantined.has(req.key) && !req.meta.safety) {
      req.resolve(asReply(CountinghouseError.withFields('VALIDATION_QUARANTINED', {module: m.name})));
      continue;
    }
    try {
      if (!slot.loaded.has(req.key)) {
        slot.worker.postMessage({type: 'load', key: req.key, name: m.name, apiText: m.apiText, schemaText: m.schemaText});
        slot.loaded.add(req.key);
      }
      slot.current = req;
      req.timer = setTimeout(() => this.fail(slot, 'its deadline'), this.timeoutMs);
      slot.worker.postMessage(req.msg);
    } catch (e) {
      // the value cannot be cloned (a function, a Symbol): not validated, and
      // not sendable to the module's worker either
      if (req.timer != null) clearTimeout(req.timer);
      slot.current = null;
      req.resolve(req.meta.safety ? null : asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the value could not be sent between threads')));
    }
  }
};

ValidatorPool.prototype.onMessage = function(slot, msg) {
  if (msg == null) return;
  if (msg.type === 'log') return LOG.W(msg.text);
  if (msg.type === 'ready') {
    slot.ready = true;
    return this.dispatch();
  }
  if (msg.type !== 'answer') return;
  const req = slot.current;
  if (req == null || req.msg.id !== msg.id) return;
  clearTimeout(req.timer);
  slot.current = null;
  if (req.meta.safety) {
    req.resolve(msg.failed != null ? null : msg.problem);
  } else if (msg.failed != null) {
    req.resolve(asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', `the module's validation failed to run (${String(msg.failed).slice(0, 64)})`)));
  } else if (msg.refused == null) {
    req.resolve(null);
  } else {
    req.resolve([CountinghouseError.fromReplyFields(msg.refused.fields), msg.refused.data]);
  }
  this.dispatch();
};

// The request `slot` holds missed its deadline, or the worker ended: the
// worker is replaced, the request refused VALIDATION_TIMEOUT, and the module
// given a strike.
ValidatorPool.prototype.fail = function(slot, why) {
  const req = slot.current;
  slot.current = null;
  slot.ending = true;
  const index = this.slots.indexOf(slot);
  slot.worker.terminate().catch(() => {});
  if (index !== -1) this.slots[index] = this.spawn();
  if (req != null) {
    clearTimeout(req.timer);
    const err = CountinghouseError.withFields('VALIDATION_TIMEOUT', {module: req.meta.module, action: req.meta.action,
      which: {en: req.meta.which, zh: ZH_WHICH[req.meta.which]}, ms: this.timeoutMs});
    LOG.E(new Error(`validator: ${req.meta.module}/${req.meta.action}: ${req.meta.which} not validated: the validator was replaced after ${why} (${this.timeoutMs} ms deadline)`));
    this.strike(req.key, req.meta.module);
    req.resolve(req.meta.safety ? {timeout: err} : asReply(err));
  }
  this.dispatch();
};

ValidatorPool.prototype.strike = function(key, name) {
  if (!this.modules.has(key)) return;
  const now = Date.now();
  const times = (this.strikes.get(key) || []).filter((t) => now - t < STRIKE_WINDOW_MS);
  times.push(now);
  this.strikes.set(key, times);
  if (times.length >= STRIKES && !this.quarantined.has(key)) {
    this.quarantined.add(key);
    LOG.E(new Error(`validator: ${name}: quarantined after ${STRIKES} validation timeouts in ${STRIKE_WINDOW_MS / 60000} minutes; its calls are refused until it is loaded again`));
  }
};

ValidatorPool.prototype.close = function() {
  for (const slot of this.slots) {
    slot.ending = true;
    slot.worker.terminate().catch(() => {});
  }
  this.slots = [];
};

// The main thread's pool, started on first use.
let shared = null;
function pool() {
  if (shared == null) {
    shared = new ValidatorPool({size: options.validatorWorkers, timeoutMs: options.validationTimeoutMs,
      workerOptions: options.getOptionsForWorker()});
  }
  return shared;
}

module.exports = {ValidatorPool, pool, STRIKES, STRIKE_WINDOW_MS};
