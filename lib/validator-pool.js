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
//   one-second cool-down before it gets another, and, for ten seconds after,
//   a request of its with under a quarter of its budget left is not
//   started: a flood of slow inputs replaces about one validator a second,
//   never all of them.
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
// A replaced validator's replacement starts at once. Only a worker that
// ends before it is ready (a crash at start) makes the next start wait,
// longer each time in a row, up to RESPAWN_MAX_MS (the review of #165).
const RESPAWN_BASE_MS = 100;
const RESPAWN_MAX_MS = 5000;
// After one of a module's OWN requests stalls a validator (an output's check
// or a compile: the module's own schema or answer), the module gets no
// validator for COOLDOWN_MS, and for STALL_MEMORY_MS a request of its with
// under MIN_START_SHARE of its budget left is not started. An input's stall
// does none of this (any caller can send one: the review of #165, HIGH 1).
const COOLDOWN_MS = 1000;
const MIN_START_SHARE = 0.25;
const MIN_START_MS = 50;
const STALL_MEMORY_MS = 10000;
// An input's stall is held against its CALLER, by the R2-1 caller id (u_...,
// never a key): CALLER_STALLS within CALLER_STALL_WINDOW_MS, and that
// caller's calls to that module are refused VALIDATION_CALLER_THROTTLED for
// CALLER_COOLDOWN_MS. No one else's are.
const CALLER_STALLS = 3;
const CALLER_STALL_WINDOW_MS = 5 * 60 * 1000;
const CALLER_COOLDOWN_MS = 60 * 1000;
// Validations one caller may have in flight across the pool (the review of
// #165, HIGH 2): one key's flood cannot hold the pool.
const PER_CALLER_IN_FLIGHT = 1;

const ZH_WHICH = {input: '输入', output: '输出'};

// A refusal made here, decoded as a worker's reply is (replyFields, then
// fromReplyFields), so every caller sees it as it sees any other.
const asReply = (err, data = null) => [CountinghouseError.fromReplyFields(CountinghouseError.replyFields(err)), data];

// The delay before a worker's replacement starts, after `recent` workers in a
// row ended before they were ready: none for a first, then 100 ms, doubling,
// up to 5 s.
function respawnDelay(recent) {
  if (recent <= 1) return 0;
  return Math.min(RESPAWN_MAX_MS, RESPAWN_BASE_MS * 2 ** (recent - 2));
}

// The default pool size (the review of #165): one validator per spare CPU,
// at least 2 and at most 4.
function defaultValidatorWorkers(cpus = require('os').cpus().length) {
  return Math.max(2, Math.min(4, cpus - 1));
}

function ValidatorPool(opts) {
  const o = opts || {};
  this.size = Number.isInteger(o.size) && o.size > 0 ? o.size : 2;
  this.timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : 1000;
  this.compileMs = Number.isFinite(o.compileMs) && o.compileMs > 0 ? o.compileMs : 10000;
  this.workerOptions = o.workerOptions || {};
  this.perCaller = Number.isInteger(o.perCaller) && o.perCaller > 0 ? o.perCaller : PER_CALLER_IN_FLIGHT;
  this.modules = new Map();      // key -> {name, apiText, schemaText}
  this.queues = new Map();       // key -> [request], in arrival order
  this.order = [];               // keys with requests, round-robin
  this.busy = new Map();         // key -> validators it holds
  this.strikes = new Map();      // module name -> [times]
  this.quarantined = new Set();  // module names
  this.respawns = [];            // times of replacements (the tests read it)
  this.startFailures = 0;        // workers in a row that ended before they were ready
  this.callerBusy = new Map();   // caller id -> validations in flight
  this.callerStalls = new Map(); // caller id + module name -> [times its inputs stalled a validator]
  this.callerBlocked = new Map(); // caller id + module name -> until when its calls are refused
  this.callerStalledAt = new Map(); // caller id -> when its input last stalled a validator
  this.cooldown = new Map();     // key -> until when its requests wait (COOLDOWN_MS)
  this.stalledAt = new Map();    // key -> when one of its requests last stalled a validator
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

// replacement: true for a validator that takes a replaced one's place; it
// (and the spare) warms every known module before it takes a call. The first
// validators serve at once: a module is compiled at its load (warm).
ValidatorPool.prototype.spawn = function(delayMs, replacement = false) {
  // compiled: key -> Set of 'serviceID\nactionName', or 'all'
  // background: id -> key, a module's actions compiled in the background
  // (backgroundWarm), answered whatever the slot is doing
  const slot = {worker: null, loaded: new Set(), compiled: new Map(), background: new Map(), current: null, ending: false, ready: false, replacement: replacement};
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
  this.stalledAt.delete(key);
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
// caller: the R2-1 caller id (u_...) of whoever the call is for, or null.
// It is never a key, and only counts here (the per-caller rules above).
ValidatorPool.prototype.check = function(key, serviceID, actionName, which, args, caller = null) {
  const m = this.modules.get(key);
  if (m == null) return Promise.resolve(asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the module\'s validation is not loaded')));
  if (this.quarantined.has(m.name)) return Promise.resolve(asReply(CountinghouseError.withFields('VALIDATION_QUARANTINED', {module: m.name})));
  const throttled = this.throttledFor(caller, m.name, actionName);
  if (throttled != null) return Promise.resolve(throttled);
  return this.request(key, 'check', {type: 'check', key: key, serviceID: serviceID, actionName: actionName, which: which, args: args},
    {action: actionName, which: which, actionId: actionId(serviceID, actionName), serviceID: serviceID, actionName: actionName, caller: caller}, this.timeoutMs);
};

// -> the refusal when `caller`'s inputs to module `name` stalled validators
// too often lately (CALLER_STALLS), else null.
ValidatorPool.prototype.throttledFor = function(caller, name, actionName) {
  if (caller == null) return null;
  const until = this.callerBlocked.get(`${caller}\n${name}`) || 0;
  const left = until - Date.now();
  if (left <= 0) return null;
  return asReply(CountinghouseError.withFields('VALIDATION_CALLER_THROTTLED', {module: name, action: actionName,
    stalls: CALLER_STALLS, minutes: CALLER_STALL_WINDOW_MS / 60000, seconds: Math.ceil(left / 1000)}));
};

// An input's stall, held against its caller only.
ValidatorPool.prototype.callerStalled = function(caller, name) {
  if (caller == null) return;
  const now = Date.now();
  this.callerStalledAt.set(caller, now);
  const at = `${caller}\n${name}`;
  const times = (this.callerStalls.get(at) || []).filter((t) => now - t < CALLER_STALL_WINDOW_MS);
  times.push(now);
  this.callerStalls.set(at, times);
  if (times.length >= CALLER_STALLS) {
    this.callerBlocked.set(at, now + CALLER_COOLDOWN_MS);
    this.callerStalls.delete(at);
    LOG.E(new Error(`validator: ${name}: one caller's inputs missed the deadline ${CALLER_STALLS} times in ${CALLER_STALL_WINDOW_MS / 60000} minutes; that caller's calls to it are refused for ${CALLER_COOLDOWN_MS / 1000} s`));
  }
};

// -> Promise of null, a problem ({path, reason}), or {timeout: error}: the
// load-time schema-safety check (lib/schema-safety.js), run in a validator.
// A check that fails to run is a problem: the load fails closed.
ValidatorPool.prototype.safety = function(key) {
  if (!this.modules.has(key)) return Promise.resolve(null);
  return this.request(key, 'safety', {type: 'safety', key: key}, {action: '(schema.json)', which: 'input'}, this.compileMs);
};

// -> Promise of null, {specError: {message, validationErrors}}, or {timeout:
// error}: a module's api.json against the device spec's own schema, run in a
// validator under the compile budget (lib/module-spec.js deviceSpec). A check
// that fails to run is a specError: the load fails closed.
ValidatorPool.prototype.deviceSpec = function(key) {
  if (!this.modules.has(key)) return Promise.resolve(null);
  return this.request(key, 'devicespec', {type: 'devicespec', key: key}, {action: '(api.json)', which: 'input'}, this.compileMs);
};

// -> Promise of null, or {timeout: error} / {failed: name}: every action of
// the module compiled in a validator at load, under the compile budget.
// Once it passes in one validator, every other validator in service compiles
// the module in the background too, off any call's path, and takes no call
// until it is done: a module's first calls go to one that has it, never wait
// on a compile (the review of #165).
ValidatorPool.prototype.warm = function(key) {
  if (!this.modules.has(key)) return Promise.resolve(null);
  return this.request(key, 'warm', {type: 'compile', key: key, actions: 'all'}, {action: '(every action)', which: 'input'}, this.compileMs)
    .then((answer) => {
      if (answer == null) for (const slot of this.slots) if (slot.ready && !slot.ending && slot.compiled.get(key) !== 'all') this.backgroundWarm(slot, key);
      return answer;
    });
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
// The validators a request may be sent to: ready, not ending, and not
// compiling in the background (a call never waits behind a warm-up).
ValidatorPool.prototype.servable = function(slot) {
  return slot.current == null && !slot.ending && slot.ready && slot.background.size === 0;
};

// A module's share: all but one of the READY validators (the review of #165),
// never fewer than one.
ValidatorPool.prototype.perModuleNow = function() {
  return Math.max(1, this.slots.filter((s) => s.ready && !s.ending).length - 1);
};

// The next request to serve: round-robin among the modules under their
// share, out of cool-down; within a module, the first request whose caller
// has fewer than perCaller validations in flight. -> {key, index} or null.
// A caller whose input stalled a validator in the last STALL_MEMORY_MS never
// takes the last free validator: while replacements boot, another caller
// finds one (the review of #165).
ValidatorPool.prototype.nextPick = function(free) {
  const now = Date.now();
  const share = this.perModuleNow();
  const fits = (r) => {
    const caller = (r.meta != null) ? r.meta.caller : null;
    if (caller == null) return true;
    if ((this.callerBusy.get(caller) || 0) >= this.perCaller) return false;
    return !(free <= 1 && now - (this.callerStalledAt.get(caller) || -Infinity) < STALL_MEMORY_MS);
  };
  for (const key of this.order) {
    const queue = this.queues.get(key) || [];
    if (queue.length === 0 || (this.busy.get(key) || 0) >= share) continue;
    if ((this.cooldown.get(key) || 0) > now) continue;
    const index = queue.findIndex(fits);
    if (index !== -1) return {key, index};
  }
  return null;
};

ValidatorPool.prototype.dispatch = function() {
  for (const slot of this.slots) {
    if (!this.servable(slot)) continue;
    const pick = this.nextPick(this.slots.filter((s) => this.servable(s)).length);
    if (pick == null) return;
    const key = pick.key;
    const queue = this.queues.get(key);
    const req = queue.splice(pick.index, 1)[0];
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
  // a module whose own output or compile stalls validators, with too little
  // of its budget left to be worth one (MIN_START_SHARE); never for inputs
  const now = Date.now();
  const left = req.deadlineAt - now;
  if (now - (this.stalledAt.get(req.key) || -Infinity) < STALL_MEMORY_MS && left < Math.max(MIN_START_MS, req.budgetMs * MIN_START_SHARE)) {
    return this.refuse(req, 'its wait in the queue', false);
  }
  const m = this.modules.get(req.key);
  if (m == null) return this.finish(req, req.kind === 'check' ? asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the module\'s validation is not loaded')) : null);
  if (req.kind === 'check' && this.quarantined.has(m.name)) return this.finish(req, asReply(CountinghouseError.withFields('VALIDATION_QUARANTINED', {module: m.name})));
  if (req.kind === 'check') {
    const throttled = this.throttledFor(req.meta.caller, m.name, req.meta.action);
    if (throttled != null) return this.finish(req, throttled);
  }
  slot.current = req;
  req.slot = slot;
  this.busy.set(req.key, (this.busy.get(req.key) || 0) + 1);
  const caller = (req.meta != null) ? req.meta.caller : null;
  if (caller != null) this.callerBusy.set(caller, (this.callerBusy.get(caller) || 0) + 1);
  const compiled = slot.compiled.get(req.key);
  if (req.kind === 'check' && compiled !== 'all' && !(compiled != null && compiled.has(req.meta.actionId))) {
    // The action is compiled first in this worker. The call never waits past
    // its own deadline (the review of #165): if the compile is not done by
    // then, the call is refused with no strike, and the compile goes on in
    // the background under the compile budget (onDeadline).
    req.phase = 'compile';
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
  req.startedAt = Date.now();
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
  for (const pending of slot.background.values()) if (pending.key === key && pending.actionId == null) return;
  const id = this.nextId++;
  try {
    this.post(slot, {type: 'compile', id: id, key: key, actions: 'all'});
    this.watchBackground(slot, id, {key: key, actionId: null});
  } catch (e) { /* compiled on demand instead */ }
};

// The slot is free again.
ValidatorPool.prototype.release = function(slot) {
  const req = slot.current;
  slot.current = null;
  if (req != null) {
    const n = (this.busy.get(req.key) || 1) - 1;
    if (n > 0) this.busy.set(req.key, n); else this.busy.delete(req.key);
    const caller = (req.meta != null) ? req.meta.caller : null;
    if (caller != null) {
      const c = (this.callerBusy.get(caller) || 1) - 1;
      if (c > 0) this.callerBusy.set(caller, c); else this.callerBusy.delete(caller);
    }
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
    this.startFailures = 0;
    // A replacement and the spare compile every module they may be asked
    // about in the background, off any call's path (the review of #165): no
    // call is sent to a replacement until that is done. The first validators
    // serve at once.
    if (slot === this.spare || slot.replacement) for (const key of this.modules.keys()) this.backgroundWarm(slot, key);
    return this.dispatch();
  }
  if (msg.type !== 'answer') return;
  if (slot.background.has(msg.id)) {
    const job = slot.background.get(msg.id);
    slot.background.delete(msg.id);
    clearTimeout(job.timer);
    if (msg.failed == null && this.modules.has(job.key)) {
      if (job.actionId == null) slot.compiled.set(job.key, 'all');
      else {
        if (!slot.compiled.has(job.key)) slot.compiled.set(job.key, new Set());
        const set = slot.compiled.get(job.key);
        if (set !== 'all') set.add(job.actionId);
      }
    }
    return this.dispatch();
  }
  const req = slot.current;
  if (req == null) return;
  if (req.phase === 'compile' && msg.id === req.compileId) {
    if (msg.failed == null) {
      if (!slot.compiled.has(req.key)) slot.compiled.set(req.key, new Set());
      const set = slot.compiled.get(req.key);
      if (set !== 'all') set.add(req.meta.actionId);
    }
    return this.send(slot, req);
  }
  if (req.msg.id !== msg.id) return;
  this.release(slot);
  if (req.kind === 'safety') {
    this.finish(req, (msg.failed != null) ? {path: '', reason: `the check failed to run (${String(msg.failed).slice(0, 64)})`} : msg.problem);
  } else if (req.kind === 'devicespec') {
    this.finish(req, (msg.failed != null) ? {specError: {message: `the check failed to run (${String(msg.failed).slice(0, 64)})`, validationErrors: []}}
      : ((msg.specError != null) ? {specError: msg.specError} : null));
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
  if (req.slot != null && req.slot.current === req) {
    if (req.phase === 'compile') {
      // The call's own deadline passed while its action compiled: refused,
      // with no strike, and the compile goes on in the background, under the
      // compile budget (the review of #165). The validator takes no call
      // until it is done.
      const slot = req.slot;
      this.release(slot);
      this.watchBackground(slot, req.compileId, {key: req.key, actionId: req.meta.actionId});
      return this.refuse(req, 'its action still compiling', false);
    }
    // Started late (its wait in the queue used most of its deadline): it is
    // refused as a wait, never as a stall of its own, and its validator is
    // given a full budget from the start before it counts as stalled.
    const slot = req.slot;
    const ran = Date.now() - (req.startedAt || Date.now());
    if (ran < req.budgetMs) {
      this.refuse(req, 'its wait in the queue', false);
      req.timer = setTimeout(() => { if (slot.current === req) this.fail(slot, 'its deadline'); }, req.budgetMs - ran);
      return;
    }
    return this.fail(slot, 'its deadline');
  }
};

// A compile in `slot` with no call waiting on it. The module's schemas were
// compiled within the budget at its load, so a slow one here is the machine
// (every new validator warms every module at once), never a strike: past the
// budget it is logged, and past three budgets the validator is replaced.
const BACKGROUND_LIMIT = 3;
ValidatorPool.prototype.watchBackground = function(slot, id, job) {
  const nameOf = () => { const m = this.modules.get(job.key); return (m != null) ? m.name : job.key.replace(/#.*$/, ''); };
  job.timer = setTimeout(() => {
    if (!slot.background.has(id) || slot.ending) return;
    if (!this.modules.has(job.key)) { slot.background.delete(id); return this.dispatch(); }
    LOG.W(`validator: ${nameOf()}: compiling in the background past ${this.compileMs} ms`);
    job.timer = setTimeout(() => {
      if (!slot.background.has(id) || slot.ending) return;
      slot.background.delete(id);
      LOG.E(new Error(`validator: ${nameOf()}: compiling in the background past ${BACKGROUND_LIMIT * this.compileMs} ms; the validator is replaced`));
      this.fail(slot, 'its background compile');
    }, (BACKGROUND_LIMIT - 1) * this.compileMs);
    job.timer.unref();
  }, this.compileMs);
  job.timer.unref();
  slot.background.set(id, job);
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
  this.respawns.push(now);
  if (this.respawns.length > 100) this.respawns.shift();
  // at once, unless workers keep ending before they are ready
  if (!slot.ready) this.startFailures += 1;
  const delay = slot.ready ? 0 : respawnDelay(this.startFailures);
  for (const job of slot.background.values()) clearTimeout(job.timer);
  slot.background.clear();
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
      this.slots[index] = this.spawn(delay, true);
    }
  }
  const ownStall = req != null && (req.phase === 'compile' || req.kind === 'warm' || (req.kind === 'check' && req.meta.which === 'output'));
  if (ownStall) {
    // the module's own output or compile: it waits a cool-down before it
    // gets another validator
    this.cooldown.set(req.key, now + COOLDOWN_MS);
    this.stalledAt.set(req.key, now);
    setTimeout(() => this.dispatch(), COOLDOWN_MS + 5).unref();
    // a call answered already (it started late, and was refused as a wait)
    // whose check then ran a full budget: a stall all the same
    if (req.done) {
      const m = this.modules.get(req.key);
      const name = (m != null) ? m.name : req.key.replace(/#.*$/, '');
      LOG.E(new Error(`validator: ${name}/${req.meta.action}: ${req.meta.which} ran past a full budget (${why}); a strike against the module`));
      this.strike(name);
    }
  } else if (req != null && req.kind === 'check' && req.meta.which === 'input') {
    // an input's: held against its caller, and nothing else
    const m = this.modules.get(req.key);
    this.callerStalled(req.meta.caller, (m != null) ? m.name : req.key.replace(/#.*$/, ''));
  }
  if (req != null && !req.done) {
    // Its own schema or output: a compile, a warm compile or an output's
    // check. Not an input's (any caller can send one), nor the safety check.
    this.refuse(req, why, ownStall);
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

module.exports = {ValidatorPool, pool, respawnDelay, defaultValidatorWorkers, STRIKES, STRIKE_WINDOW_MS, CALLER_STALLS, CALLER_COOLDOWN_MS};
