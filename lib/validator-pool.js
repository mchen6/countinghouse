// The validator pool (lean worker step 1(b), as the reviewer corrected it on
// #152, 2026-11-13): a module's input and output are validated in one of a
// few shared validator workers (lib/validator-worker.js), never on the main
// thread and never in the module's own worker.
//
// - Workers: --validatorWorkers (default 2), each with resource limits,
//   started on first use and replaced (with a growing backoff when they keep
//   being replaced) when a request misses its deadline or a worker ends; one
//   more is kept started and idle, to take a replaced one's place at once.
// - Fairness between tenants: one queue per module, served round-robin
//   across modules, and a module holds at most (workers - 1) validators at
//   once, even with no other waiting, so a flood of one module's calls
//   always leaves a validator free for another's. A worker takes one request
//   at a time. A module whose request just stalled a validator waits a
//   one-second cool-down before it gets another, and a request with under a
//   quarter of its budget left is not started: a flood of slow inputs
//   replaces about one validator a second, never all of them.
// - The deadline, --validationTimeoutMs (default 1000), runs from when the
//   request is queued: queue wait plus run. Past it the call is refused
//   VALIDATION_TIMEOUT (naming the module, the action and the side, never a
//   key or a value) and logged; a request still queued is dropped, never
//   validated and never sent on; one running has its worker replaced.
// - Compiling has its own budget, --validationCompileMs (default 10000): a
//   module's actions are compiled at load (warm), and refused past it
//   (MODULE_ASSEMBLY_FAIL, stage schemaCompile), and one action at a time
//   again in a validator that replaced one, before its check, the check's
//   deadline then resuming.
// - Strikes: an output's timeout and a compile's count against the module
//   (its own schema or output did it); an input's does not (any caller can
//   send a slow input), nor a wait in the queue. 3 strikes in 5 minutes
//   quarantine the module by name: VALIDATION_QUARANTINED until an operator
//   loads it again (a supervisor's restart does not clear it).
// - The value checked is the structured clone posted to the worker: exactly
//   what the module's worker receives.
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
// A worker replaced again within RESPAWN_WINDOW_MS of the last time waits
// longer each time before its replacement starts, up to RESPAWN_MAX_MS.
const RESPAWN_WINDOW_MS = 60 * 1000;
const RESPAWN_BASE_MS = 100;
const RESPAWN_MAX_MS = 5000;
// After one of a module's requests stalls a validator (it is replaced), the
// module gets no validator for COOLDOWN_MS: its queued requests wait, and are
// refused at their deadline if the cool-down outlasts it. A flood of slow
// inputs then replaces at most about one validator a second, which the spare
// and the backoff absorb, instead of every validator in turn.
const COOLDOWN_MS = 1000;
// A request is not started with less than this share of its budget left
// (and at least MIN_START_MS): a slow one would only stall a validator for
// the rest, and is refused as a wait in the queue instead.
const MIN_START_SHARE = 0.25;
const MIN_START_MS = 50;

const ZH_WHICH = {input: '输入', output: '输出'};

// A refusal made here, decoded as a worker's reply is (replyFields, then
// fromReplyFields), so every caller sees it as it sees any other.
const asReply = (err, data = null) => [CountinghouseError.fromReplyFields(CountinghouseError.replyFields(err)), data];

// The delay before a worker's replacement starts, after `recent` replacements
// within the window: none for the first, then 100 ms, doubling, up to 5 s.
function respawnDelay(recent) {
  if (recent <= 1) return 0;
  return Math.min(RESPAWN_MAX_MS, RESPAWN_BASE_MS * 2 ** (recent - 2));
}

function ValidatorPool(opts) {
  const o = opts || {};
  this.size = Number.isInteger(o.size) && o.size > 0 ? o.size : 2;
  this.timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : 1000;
  this.compileMs = Number.isFinite(o.compileMs) && o.compileMs > 0 ? o.compileMs : 10000;
  this.workerOptions = o.workerOptions || {};
  this.perModule = Math.max(1, this.size - 1);
  this.modules = new Map();      // key -> {name, apiText, schemaText}
  this.queues = new Map();       // key -> [request], in arrival order
  this.order = [];               // keys with requests, round-robin
  this.busy = new Map();         // key -> validators it holds
  this.strikes = new Map();      // module name -> [times]
  this.quarantined = new Set();  // module names
  this.respawns = [];            // times of recent replacements
  this.cooldown = new Map();     // key -> until when its requests wait (COOLDOWN_MS)
  this.logged = new Set();       // module name and level of an ajv line logged
  this.nextId = 1;
  this.stats = {sent: 0};        // checks posted to a worker (the tests read it)
  this.closed = false;
  this.slots = [];
  for (let i = 0; i < this.size; i++) this.slots.push(this.spawn(0));
  // One more, started and idle: a replaced validator's place is taken at
  // once by a ready one, so a replacement's start (about a second) never
  // leaves the pool short, when fairness needs a validator free.
  this.spare = this.spawn(0);
}

ValidatorPool.prototype.spawn = function(delayMs) {
  // compiled: key -> Set of 'serviceID\nactionName', or 'all'
  // background: id -> key, a module's actions compiled in the background
  // (backgroundWarm), answered whatever the slot is doing
  const slot = {worker: null, loaded: new Set(), compiled: new Map(), background: new Map(), current: null, ending: false, ready: false};
  const start = () => {
    if (this.closed) return;
    const worker = new Worker(WORKER_FILE, {workerData: {options: this.workerOptions}, resourceLimits: RESOURCE_LIMITS});
    worker.unref();
    slot.worker = worker;
    worker.on('message', (msg) => this.onMessage(slot, msg));
    // A worker that ends on its own (a crash, its memory limit) fails the
    // request it held, as a missed deadline does.
    const ended = () => { if (!slot.ending) this.fail(slot, 'its end'); };
    worker.on('error', ended);
    worker.on('exit', ended);
  };
  if (delayMs > 0) setTimeout(start, delayMs).unref(); else start();
  return slot;
};

// Registers a module's files under `key` (one per start of the module);
// sent to a worker on its first request there.
ValidatorPool.prototype.register = function(key, name, apiText, schemaText) {
  this.modules.set(key, {name: name, apiText: apiText, schemaText: schemaText});
  this.backgroundWarm(this.spare, key);
};

// The key's spec is no longer used (its worker ended). Its quarantine, kept
// by module name, stays.
ValidatorPool.prototype.forget = function(key) {
  this.modules.delete(key);
  this.cooldown.delete(key);
  for (const req of (this.queues.get(key) || [])) {
    this.finish(req, req.kind === 'check' ? asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the module\'s validation is not loaded')) : null);
  }
  this.order = this.order.filter((k) => k !== key);
  this.queues.delete(key);
  for (const slot of this.slots) {
    slot.compiled.delete(key);
    if (slot.loaded.delete(key) && slot.worker != null) slot.worker.postMessage({type: 'forget', key: key});
  }
};

ValidatorPool.prototype.isQuarantined = function(name) {
  return this.quarantined.has(name);
};

// An operator's load of the module: its strikes and quarantine end.
ValidatorPool.prototype.clearQuarantine = function(name) {
  this.strikes.delete(name);
  this.quarantined.delete(name);
};

const actionId = (serviceID, actionName) => `${serviceID}\n${actionName}`;

// -> Promise of null (the side passes) or [error, data], the call's answer.
ValidatorPool.prototype.check = function(key, serviceID, actionName, which, args) {
  const m = this.modules.get(key);
  if (m == null) return Promise.resolve(asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the module\'s validation is not loaded')));
  if (this.quarantined.has(m.name)) return Promise.resolve(asReply(CountinghouseError.withFields('VALIDATION_QUARANTINED', {module: m.name})));
  return this.request(key, 'check', {type: 'check', key: key, serviceID: serviceID, actionName: actionName, which: which, args: args},
    {action: actionName, which: which, actionId: actionId(serviceID, actionName), serviceID: serviceID, actionName: actionName}, this.timeoutMs);
};

// -> Promise of null, a problem ({path, reason}), or {timeout: error}: the
// load-time schema-safety check (lib/schema-safety.js), run in a validator.
// A check that fails to run is a problem: the load fails closed.
ValidatorPool.prototype.safety = function(key) {
  if (!this.modules.has(key)) return Promise.resolve(null);
  return this.request(key, 'safety', {type: 'safety', key: key}, {action: '(schema.json)', which: 'input'}, this.compileMs);
};

// -> Promise of null, or {timeout: error} / {failed: name}: every action of
// the module compiled in a validator at load, under the compile budget.
ValidatorPool.prototype.warm = function(key) {
  if (!this.modules.has(key)) return Promise.resolve(null);
  return this.request(key, 'warm', {type: 'compile', key: key, actions: 'all'}, {action: '(every action)', which: 'input'}, this.compileMs);
};

ValidatorPool.prototype.request = function(key, kind, msg, meta, budgetMs) {
  return new Promise((resolve) => {
    const req = {key: key, kind: kind, msg: Object.assign({id: this.nextId++}, msg), meta: meta, resolve: resolve,
      done: false, slot: null, phase: 'queued', deadlineAt: Date.now() + budgetMs, budgetMs: budgetMs, timer: null};
    req.timer = setTimeout(() => this.onDeadline(req), budgetMs);
    if (!this.queues.has(key)) this.queues.set(key, []);
    this.queues.get(key).push(req);
    if (!this.order.includes(key)) this.order.push(key);
    this.dispatch();
  });
};

// Answers a request once; never again, whatever arrives later.
ValidatorPool.prototype.finish = function(req, answer) {
  if (req.done) return;
  req.done = true;
  clearTimeout(req.timer);
  req.resolve(answer);
};

// The next module to serve: round-robin among the modules holding fewer
// validators than their share (workers - 1). Never more, even when no other
// module is waiting: one that arrives must find a validator free at once.
ValidatorPool.prototype.nextKey = function() {
  const now = Date.now();
  for (const key of this.order) {
    if ((this.queues.get(key) || []).length === 0 || (this.busy.get(key) || 0) >= this.perModule) continue;
    if ((this.cooldown.get(key) || 0) > now) continue;
    return key;
  }
  return null;
};

ValidatorPool.prototype.dispatch = function() {
  for (const slot of this.slots) {
    if (slot.current != null || slot.ending || !slot.ready) continue;
    const key = this.nextKey();
    if (key == null) return;
    const queue = this.queues.get(key);
    const req = queue.shift();
    if (queue.length === 0) this.queues.delete(key);
    // the module is served: to the back of the round
    this.order = this.order.filter((k) => k !== key);
    if (this.queues.has(key)) this.order.push(key);
    if (req.done) continue;
    this.start(slot, req);
    // a request that could not be posted left the slot free: serve on
    if (slot.current == null) return this.dispatch();
  }
};

ValidatorPool.prototype.post = function(slot, msg) {
  const m = this.modules.get(msg.key);
  if (!slot.loaded.has(msg.key)) {
    slot.worker.postMessage({type: 'load', key: msg.key, name: m.name, apiText: m.apiText, schemaText: m.schemaText});
    slot.loaded.add(msg.key);
  }
  slot.worker.postMessage(msg);
};

ValidatorPool.prototype.start = function(slot, req) {
  // too little of its budget left to be worth a validator (MIN_START_SHARE)
  const left = req.deadlineAt - Date.now();
  if (left < Math.max(MIN_START_MS, req.budgetMs * MIN_START_SHARE)) return this.refuse(req, 'its wait in the queue', false);
  const m = this.modules.get(req.key);
  if (m == null) return this.finish(req, req.kind === 'check' ? asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the module\'s validation is not loaded')) : null);
  if (req.kind === 'check' && this.quarantined.has(m.name)) return this.finish(req, asReply(CountinghouseError.withFields('VALIDATION_QUARANTINED', {module: m.name})));
  slot.current = req;
  req.slot = slot;
  this.busy.set(req.key, (this.busy.get(req.key) || 0) + 1);
  const compiled = slot.compiled.get(req.key);
  if (req.kind === 'check' && compiled !== 'all' && !(compiled != null && compiled.has(req.meta.actionId))) {
    // The action is compiled first in this worker, under the compile budget;
    // the check's own deadline is held meanwhile and resumes after.
    clearTimeout(req.timer);
    req.remaining = Math.max(0, req.deadlineAt - Date.now());
    req.phase = 'compile';
    req.timer = setTimeout(() => this.onDeadline(req), this.compileMs);
    req.compileId = this.nextId++;
    try {
      this.post(slot, {type: 'compile', id: req.compileId, key: req.key, actions: [[req.meta.serviceID, req.meta.actionName]]});
    } catch (e) {
      this.release(slot);
      return this.finish(req, asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the module\'s validation could not be loaded')));
    }
    return;
  }
  this.send(slot, req);
};

ValidatorPool.prototype.send = function(slot, req) {
  req.phase = 'run';
  try {
    this.post(slot, req.msg);
    if (req.kind === 'check') this.stats.sent++;
  } catch (e) {
    // the value cannot be cloned (a function, a Symbol): not validated, and
    // not sendable to the module's worker either
    this.release(slot);
    this.finish(req, req.kind === 'check' ? asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the value could not be sent between threads')) : {failed: 'unsendable'});
    // the slot is free again: the queue goes on (from a compile's answer
    // nothing else would serve it)
    setImmediate(() => this.dispatch());
  }
};

// Every action of `key` compiled in the spare in the background, with no
// deadline of a call: a compile it has not done or started. The spare takes
// a place only once these are done (fail).
ValidatorPool.prototype.backgroundWarm = function(slot, key) {
  if (slot == null || !slot.ready || slot.ending || slot.worker == null || slot.compiled.get(key) === 'all') return;
  for (const pending of slot.background.values()) if (pending === key) return;
  const id = this.nextId++;
  try {
    this.post(slot, {type: 'compile', id: id, key: key, actions: 'all'});
    slot.background.set(id, key);
  } catch (e) { /* compiled on demand instead */ }
};

// The slot is free again.
ValidatorPool.prototype.release = function(slot) {
  const req = slot.current;
  slot.current = null;
  if (req != null) {
    const n = (this.busy.get(req.key) || 1) - 1;
    if (n > 0) this.busy.set(req.key, n); else this.busy.delete(req.key);
  }
};

ValidatorPool.prototype.onMessage = function(slot, msg) {
  if (msg == null) return;
  if (msg.type === 'log') {
    // one line per module per level across every validator (each worker
    // bounds its own; a module is compiled in more than one)
    const once = `${msg.name}\n${msg.level}`;
    if (this.logged.has(once)) return;
    this.logged.add(once);
    return LOG.W(msg.text);
  }
  if (msg.type === 'ready') {
    slot.ready = true;
    // The spare compiles every module while it waits, so taking a place
    // seldom means compiling inside a call; a validator in service compiles
    // an action when it is first asked (its single thread is the calls').
    if (slot === this.spare) for (const key of this.modules.keys()) this.backgroundWarm(slot, key);
    return this.dispatch();
  }
  if (msg.type !== 'answer') return;
  if (slot.background.has(msg.id)) {
    const key = slot.background.get(msg.id);
    slot.background.delete(msg.id);
    if (msg.failed == null && this.modules.has(key)) slot.compiled.set(key, 'all');
    return;
  }
  const req = slot.current;
  if (req == null) return;
  if (req.phase === 'compile' && msg.id === req.compileId) {
    if (msg.failed == null) {
      if (!slot.compiled.has(req.key)) slot.compiled.set(req.key, new Set());
      const set = slot.compiled.get(req.key);
      if (set !== 'all') set.add(req.meta.actionId);
    }
    clearTimeout(req.timer);
    req.timer = setTimeout(() => this.onDeadline(req), req.remaining);
    return this.send(slot, req);
  }
  if (req.msg.id !== msg.id) return;
  this.release(slot);
  if (req.kind === 'safety') {
    this.finish(req, (msg.failed != null) ? {path: '', reason: `the check failed to run (${String(msg.failed).slice(0, 64)})`} : msg.problem);
  } else if (req.kind === 'warm') {
    if (msg.failed == null) slot.compiled.set(req.key, 'all');
    this.finish(req, (msg.failed != null) ? {failed: String(msg.failed).slice(0, 64)} : null);
  } else if (msg.failed != null) {
    this.finish(req, asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', `the module's validation failed to run (${String(msg.failed).slice(0, 64)})`)));
  } else if (msg.refused == null) {
    this.finish(req, null);
  } else {
    this.finish(req, [CountinghouseError.fromReplyFields(msg.refused.fields), msg.refused.data]);
  }
  this.dispatch();
};

// A request's deadline (or its compile's budget) passed. Queued: dropped,
// never validated or sent on. Running: its worker is replaced.
ValidatorPool.prototype.onDeadline = function(req) {
  if (req.done) return;
  if (req.phase === 'queued') {
    const queue = this.queues.get(req.key);
    if (queue != null) {
      const i = queue.indexOf(req);
      if (i !== -1) queue.splice(i, 1);
      if (queue.length === 0) { this.queues.delete(req.key); this.order = this.order.filter((k) => k !== req.key); }
    }
    return this.refuse(req, 'its wait in the queue', false);
  }
  if (req.slot != null && req.slot.current === req) return this.fail(req.slot, (req.phase === 'compile') ? 'its compile budget' : 'its deadline');
};

// The request `slot` holds missed its deadline, or the worker ended: the
// worker is replaced (after a backoff when it keeps happening) and the
// request refused.
ValidatorPool.prototype.fail = function(slot, why) {
  const req = slot.current;
  this.release(slot);
  slot.ending = true;
  if (slot.worker != null) slot.worker.terminate().catch(() => {});
  const index = this.slots.indexOf(slot);
  const now = Date.now();
  this.respawns = this.respawns.filter((t) => now - t < RESPAWN_WINDOW_MS);
  this.respawns.push(now);
  const delay = respawnDelay(this.respawns.length);
  if (slot === this.spare) {
    // the spare itself ended: another, after the backoff
    if (!this.closed) this.spare = this.spawn(delay);
  } else if (index !== -1 && !this.closed) {
    // the spare takes the place at once when it is ready and done compiling;
    // a new spare starts after the backoff
    if (this.spare != null && this.spare.ready && !this.spare.ending && this.spare.background.size === 0) {
      this.slots[index] = this.spare;
      this.spare = this.spawn(delay);
    } else {
      this.slots[index] = this.spawn(delay);
    }
  }
  if (req != null) {
    // the module waits a cool-down before it gets another validator
    this.cooldown.set(req.key, now + COOLDOWN_MS);
    setTimeout(() => this.dispatch(), COOLDOWN_MS + 5).unref();
  }
  if (req != null && !req.done) {
    // Its own schema or output: a compile, a warm compile or an output's
    // check. Not an input's (any caller can send one), nor the safety check.
    const strike = req.phase === 'compile' || req.kind === 'warm' || (req.kind === 'check' && req.meta.which === 'output');
    this.refuse(req, why, strike);
  }
  this.dispatch();
};

ValidatorPool.prototype.refuse = function(req, why, strike) {
  const m = this.modules.get(req.key);
  const name = (m != null) ? m.name : req.key.replace(/#.*$/, '');
  if (req.kind === 'warm') {
    LOG.E(new Error(`validator: ${name}: its schemas were not compiled within ${this.compileMs} ms (${why})`));
    if (strike) this.strike(name);
    return this.finish(req, {timeout: CountinghouseError.withFields('VALIDATION_TIMEOUT', {module: name, action: req.meta.action,
      which: {en: req.meta.which, zh: ZH_WHICH[req.meta.which]}, ms: this.compileMs})});
  }
  const ms = (req.kind === 'check') ? this.timeoutMs : this.compileMs;
  const err = CountinghouseError.withFields('VALIDATION_TIMEOUT', {module: name, action: req.meta.action,
    which: {en: req.meta.which, zh: ZH_WHICH[req.meta.which]}, ms: ms});
  LOG.E(new Error(`validator: ${name}/${req.meta.action}: ${req.meta.which} not validated: ${why} (${ms} ms)${strike ? '; a strike against the module' : ''}`));
  if (strike) this.strike(name);
  this.finish(req, (req.kind === 'check') ? asReply(err) : {timeout: err});
};

ValidatorPool.prototype.strike = function(name) {
  const now = Date.now();
  const times = (this.strikes.get(name) || []).filter((t) => now - t < STRIKE_WINDOW_MS);
  times.push(now);
  this.strikes.set(name, times);
  if (times.length >= STRIKES && !this.quarantined.has(name)) {
    this.quarantined.add(name);
    LOG.E(new Error(`validator: ${name}: quarantined after ${STRIKES} validation timeouts of its own outputs or compiles in ${STRIKE_WINDOW_MS / 60000} minutes; its calls are refused until an operator loads it again`));
  }
};

ValidatorPool.prototype.close = function() {
  this.closed = true;
  for (const slot of this.slots.concat(this.spare != null ? [this.spare] : [])) {
    slot.ending = true;
    if (slot.worker != null) slot.worker.terminate().catch(() => {});
  }
  this.slots = [];
};

// The main thread's pool, started on first use.
let shared = null;
function pool() {
  if (shared == null) {
    shared = new ValidatorPool({size: options.validatorWorkers, timeoutMs: options.validationTimeoutMs,
      compileMs: options.validationCompileMs, workerOptions: options.getOptionsForWorker()});
  }
  return shared;
}

module.exports = {ValidatorPool, pool, respawnDelay, STRIKES, STRIKE_WINDOW_MS};
