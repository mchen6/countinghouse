// The validator pool (lean worker step 1(b), as the reviewer corrected it on
// #152, 2026-11-13): a module's input and output are validated in one of a
// few shared validator workers (lib/validator-worker.js), never on the main
// thread and never in the module's own worker.
//
// - Workers: --validatorWorkers (default one per spare CPU, 2 to 4), each
//   with resource limits. A worker that misses a request's deadline, or
//   ends, is replaced at once (only workers that keep ending before they are
//   ready back off). One more, the spare, is kept started and idle from the
//   start, to take a replaced one's place at once; it warms no module.
// - Homes (2026-11-14): a module's schemas are compiled at load on one
//   validator, its home (homeIndex: FNV-1a of its name, modulo the pool's
//   size), not on every one; each validator once held every module, about
//   1.1 MB per module per validator. A request goes to a free validator that
//   has its action compiled (its home first), else to its home when that is
//   free, else to any free validator, which compiles the action on that
//   first check, under the call's own deadline (past it: refused, no strike,
//   and the compile goes on in the background), and keeps it. Homes decide
//   only where a request goes; the fairness rules below decide whether it
//   starts. A replacement compiles its slot's home modules in the background
//   before it takes a call; the spare, taking a place, serves at once and
//   compiles that slot's home modules as their checks come. Every validator
//   primes itself on a module of its own before it is ready
//   (lib/validator-worker.js), so a module's first compile there is quick.
// - Fairness between tenants (the review of #165): one queue per module,
//   served round-robin across modules; a module holds at most all but one
//   READY validator; one caller has one validation in flight across the
//   pool. A caller is a client call's R2-1 caller id (u_..., never a key), or,
//   for a hop, the CALLING MODULE (module:<name>), so a module cannot spread
//   its hops over its end users' ids. A worker takes one request at a time.
// - An input's stall is held against its caller, never the module: 3 in a
//   sliding 5 minutes and that caller's calls to that module are refused
//   VALIDATION_CALLER_THROTTLED for a minute, and a caller whose input
//   stalled lately never takes the pool's last free validator nor its
//   module's last share. A module's OWN output or compile stall cools the
//   module down for a second and, for ten seconds, refuses its requests with
//   under a quarter of their budget left unstarted.
// - The deadline, --validationTimeoutMs (default 1000), runs from when the
//   request is queued: queue wait plus run. Past it the call is refused
//   VALIDATION_TIMEOUT (naming the module, the action and the side, never a
//   key or a value) and logged; a request still queued is dropped, never
//   validated and never sent on; one running has its worker replaced, unless
//   its answer is already waiting on this thread: a pause of this thread is
//   not the validator's stall (runDeadline).
// - Compiling has its own budget, --validationCompileMs (default 10000): a
//   module's actions are compiled at load (warm), and refused past it
//   (MODULE_ASSEMBLY_FAIL, stage schemaCompile). A call whose action is still
//   compiling in its validator is refused at its own deadline with no strike,
//   and the compile goes on in the background.
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
// a validator outlives the request that may have started it (lib/unauth-limit.js)
const {outsideRequest} = require('./unauth-limit');
const LOG = require('./logger');
const {CountinghouseError} = require('./countinghouse-error');

const WORKER_FILE = path.join(__dirname, 'validator-worker.js');
const RESOURCE_LIMITS = {maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4};
// A validator unpacks a hop's result (lean worker step 2), as large as
// --maxOutputBytes (at most 256 MiB): its heap is four times the cap and 64 MB
// more (a value's heap is larger than its bytes; ajv works beside it), and
// never under RESOURCE_LIMITS'.
function resourceLimitsFor(maxOutputBytes) {
  const capMb = Number.isInteger(maxOutputBytes) && maxOutputBytes > 0 ? Math.ceil(maxOutputBytes / (1024 * 1024)) : 0;
  return Object.assign({}, RESOURCE_LIMITS, {maxOldGenerationSizeMb: Math.max(RESOURCE_LIMITS.maxOldGenerationSizeMb, capMb * 4 + 64)});
}
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

// why a request was refused, when its validator's worker ended under it
const ENDED = 'its end';

// A refusal made here, decoded as a worker's reply is (replyFields, then
// fromReplyFields), so every caller sees it as it sees any other.
const asReply = (err, data = null) => [CountinghouseError.fromReplyFields(CountinghouseError.replyFields(err)), data];

// A quarantined module's refusal, with what clears it where this runtime
// runs: the user's own restart command on a shared runtime (a client's
// restart attaches to the same one), the client's restart under --stdio, an
// operator's load of the module elsewhere. Only a restart is named to a local
// user: a pack turned off and on clears a part only if nothing else loaded
// holds it.
// (The bare command: a calling module reads a hop's refusal, and the launcher
// is a path outside its root, as lib/held-back.js says of terminalCommand.)
function clearsText() {
  if (require('./sessions').shared() === true) return 'Restarting countinghouse clears this: run `ch-local restart` in your own terminal.';
  return options.stdio === true ? 'Restarting your client clears this.' : 'Loading the module again clears this.';
}
const quarantinedError = (name) => CountinghouseError.withFields('VALIDATION_QUARANTINED', {module: name, strikes: STRIKES, minutes: STRIKE_WINDOW_MS / 60000, clears: clearsText()});

// The delay before a worker's replacement starts, after `recent` workers in a
// row ended before they were ready: none for a first, then 100 ms, doubling,
// up to 5 s.
function respawnDelay(recent) {
  if (recent <= 1) return 0;
  return Math.min(RESPAWN_MAX_MS, RESPAWN_BASE_MS * 2 ** (recent - 2));
}

// A module's home validator: FNV-1a (32 bits) of its name, modulo the
// pool's size. By name, so a module's restarts (a new key each) keep it, and
// by slot index, so a replaced validator's successor keeps its modules.
function homeIndex(name, size) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(String(name), 'utf8')) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % size;
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
  this.resourceLimits = resourceLimitsFor(o.maxOutputBytes);
  this.resizeWaitMs = Number.isFinite(o.resizeWaitMs) && o.resizeWaitMs > 0 ? o.resizeWaitMs : RESIZE_SLOT_WAIT_MS;
  this.perCaller = Number.isInteger(o.perCaller) && o.perCaller > 0 ? o.perCaller : PER_CALLER_IN_FLIGHT;
  // how long a load's request waits in the queue for a validator
  // (LOAD_QUEUE_MAX_MS; a test may give less)
  this.loadQueueMs = Number.isFinite(o.loadQueueMs) && o.loadQueueMs > 0 ? o.loadQueueMs : LOAD_QUEUE_MAX_MS;
  this.callerCooldownMs = Number.isFinite(o.callerCooldownMs) && o.callerCooldownMs > 0 ? o.callerCooldownMs : CALLER_COOLDOWN_MS;
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
// warms its slot's home modules before it takes a call. The first
// validators and the spare serve at once: a module is compiled at its load
// on its home (warm), and elsewhere as its checks land there.
ValidatorPool.prototype.spawn = function(delayMs, replacement = false) {
  // compiled: key -> Set of 'serviceID\nactionName', or 'all'
  // background: id -> key, a module's actions compiled in the background
  // (backgroundWarm), answered whatever the slot is doing
  // limitMb: the heap this slot's worker is started with (a resize replaces
  // a slot below the pool's current one); draining: a resize's, taking no
  // new request; sent: checks posted to it (the tests read it)
  const slot = {worker: null, loaded: new Set(), compiled: new Map(), promptsDerived: new Set(), background: new Map(), current: null, ending: false, ready: false, replacement: replacement, sent: 0,
    limitMb: this.resourceLimits.maxOldGenerationSizeMb, draining: false};
  const start = () => {
    // a slot retired before its delayed start (a resize) never starts
    if (this.closed || slot.ending) return;
    // the limits current when it starts (a delayed start after a resize
    // takes the new ones)
    slot.limitMb = this.resourceLimits.maxOldGenerationSizeMb;
    const worker = outsideRequest(() => new Worker(WORKER_FILE, {workerData: {options: this.workerOptions}, resourceLimits: this.resourceLimits}));
    worker.unref();
    slot.worker = worker;
    worker.on('message', (msg) => this.onMessage(slot, msg));
    // A worker that ends on its own (a crash, its memory limit) fails the
    // request it held, as a missed deadline does.
    const ended = () => { if (!slot.ending) this.fail(slot, ENDED); };
    worker.on('error', ended);
    worker.on('exit', ended);
  };
  if (delayMs > 0) setTimeout(start, delayMs).unref(); else start();
  return slot;
};

// Registers a module's files under `key` (one per start of the module);
// sent to a worker on its first request there.
ValidatorPool.prototype.register = function(key, name, apiText, schemaText) {
  this.modules.set(key, {name: name, apiText: apiText, schemaText: schemaText, home: homeIndex(name, this.size)});
};

// The slot a module's requests go to first (homeIndex), or null for a key
// the pool does not hold.
ValidatorPool.prototype.homeOf = function(key) {
  const m = this.modules.get(key);
  return (m == null) ? null : this.slots[m.home] || null;
};

// The key's spec is no longer used (its worker ended). Its quarantine, kept
// by module name, stays.
// What a request for a key the validators do not hold (forgotten, or never
// loaded) answers: a call's check is refused, an api.json check fails
// closed (#177's re-review, item 4); a load's own safety or warm check of a
// spec it just gave them answers nothing.
const NOT_LOADED_SPEC = () => ({specError: {message: 'the module\'s spec is not loaded in the validators', validationErrors: []}});
function notLoadedAnswer(req) {
  if (req.kind === 'check') return asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the module\'s validation is not loaded'));
  if (req.kind === 'devicespec') return NOT_LOADED_SPEC();
  return null;
}

ValidatorPool.prototype.forget = function(key) {
  this.modules.delete(key);
  this.cooldown.delete(key);
  this.stalledAt.delete(key);
  for (const req of (this.queues.get(key) || [])) {
    this.finish(req, notLoadedAnswer(req));
  }
  this.order = this.order.filter((k) => k !== key);
  this.queues.delete(key);
  for (const slot of this.slots) {
    slot.compiled.delete(key);
    slot.promptsDerived.delete(key);
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
  const refused = this.refusedUpFront(key, caller, actionName);
  if (refused != null) return Promise.resolve(refused);
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

// A shared-runtime session's end (lib/sessions.js close): its per-caller
// entries, keyed <caller>#<session> (validationCallerOf), go with it; what
// is in flight finishes as it would.
ValidatorPool.prototype.forgetSession = function(sessionId) {
  const tail = `#${sessionId}`;
  const ofIt = (k) => String(k).split('\n')[0].endsWith(tail);
  for (const map of [this.callerStalls, this.callerBlocked, this.callerStalledAt]) {
    for (const k of [...map.keys()]) if (ofIt(k)) map.delete(k);
  }
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
    // the history is kept: the window slides on across the block, so a
    // caller cannot stall 3 times a minute (the review of #165)
    this.callerBlocked.set(at, now + this.callerCooldownMs);
    LOG.E(new Error(`validator: ${name}: one caller's inputs missed the deadline ${CALLER_STALLS} times in ${CALLER_STALL_WINDOW_MS / 60000} minutes; that caller's calls to it are refused for ${this.callerCooldownMs / 1000} s`));
  }
};

// A check's refusal before it is queued: the module not loaded, or
// quarantined, or the caller throttled on it. -> [error, data] or null.
ValidatorPool.prototype.refusedUpFront = function(key, caller = null, actionName = null) {
  const m = this.modules.get(key);
  if (m == null) return asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'the module\'s validation is not loaded'));
  if (this.quarantined.has(m.name)) return asReply(quarantinedError(m.name));
  return this.throttledFor(caller, m.name, actionName);
};

// Lean worker step 2 (the reviewer's ruling (a) of 2026-11-13): a hop's
// result, a v8.serialize buffer (an ArrayBuffer), checked against the
// callee's output schema in a validator and given back; it is transferred
// there and back, never copied, and never deserialised on this thread.
// -> Promise of {refused: null | [error, data], buffer: ArrayBuffer | null};
// buffer is the same bytes exactly when refused is null. The ArrayBuffer
// passed in is detached once it is sent. The same queues, deadline and
// strikes as check(): a stall is an output's timeout, a strike against the
// module that answered.
ValidatorPool.prototype.checkSerialized = function(key, serviceID, actionName, which, buffer, caller = null) {
  const refused = this.refusedUpFront(key, caller, actionName);
  if (refused != null) return Promise.resolve({refused: refused, buffer: null});
  return this.request(key, 'check', {type: 'check', key: key, serviceID: serviceID, actionName: actionName, which: which, buffer: buffer},
    {action: actionName, which: which, actionId: actionId(serviceID, actionName), serviceID: serviceID, actionName: actionName, caller: caller, serialized: true}, this.timeoutMs);
};

// -> Promise of null, a problem ({path, reason}), or {timeout: error}: the
// load-time schema-safety check (lib/schema-safety.js), run in a validator.
// A check that fails to run is a problem: the load fails closed.
// -> the [serviceID, action name] pairs of the tools the module's last safety
// check found its declared text leaves unusable (#400)
ValidatorPool.prototype.hiddenUnlisted = function(key) {
  const m = this.modules.get(key);
  return (m != null && Array.isArray(m.hiddenUnlisted)) ? m.hiddenUnlisted : [];
};
ValidatorPool.prototype.safety = function(key) {
  if (!this.modules.has(key)) return Promise.resolve(null);
  return this.request(key, 'safety', {type: 'safety', key: key}, {action: '(schema.json)', which: 'input'}, this.compileMs);
};

// -> Promise of null, {specError: {message, validationErrors}}, or {timeout:
// error}: a module's api.json against the device spec's own schema, run in a
// validator under the compile budget (lib/module-spec.js deviceSpec). A check
// that fails to run is a specError: the load fails closed.
// -> Promise of {schema, valid} (schema null: the pointer names no form;
// valid null: no content was given), null (a spec the validators do not
// hold), {failed} or {timeout: error}: a question's form and whether
// `content` answers it (ctx.ask, lib/module-ask.js), in a validator, under a
// validation's own deadline. Its caller fails closed on anything but a
// plain {schema, valid}.
ValidatorPool.prototype.question = function(key, pointer, content) {
  if (!this.modules.has(key)) return Promise.resolve(null);
  const msg = {type: 'question', key: key, pointer: pointer};
  if (content !== undefined) msg.content = content;
  return this.request(key, 'question', msg, {action: '(question)', which: 'input'}, this.timeoutMs);
};

ValidatorPool.prototype.deviceSpec = function(key) {
  // a spec the validators do not hold fails closed, never passes (#177's
  // re-review, item 4)
  if (!this.modules.has(key)) return Promise.resolve(NOT_LOADED_SPEC());
  return this.request(key, 'devicespec', {type: 'devicespec', key: key}, {action: '(api.json)', which: 'input'}, this.compileMs);
};

// -> Promise of null, or {timeout: error} / {failed: name}: every action of
// the module compiled at load, under the compile budget, on its home
// validator (a load's requests wait LOAD_HOME_WAIT_MS for their home, then
// take any free validator: a home kept busy or booting never fails a load).
// A module's schemas are held by one validator, not by every one. Its
// checks go there first; one that finds the home busy compiles its action
// where it runs instead.
ValidatorPool.prototype.warm = function(key) {
  if (!this.modules.has(key)) return Promise.resolve(null);
  return this.request(key, 'warm', {type: 'compile', key: key, actions: 'all'}, {action: '(every action)', which: 'input'}, this.compileMs);
};

// MCP completeness M10 (lib/prompt-arguments.js), never on the main thread:
// prompts(key) -> Promise of {prompts: {name: [args] | null}, resourceCompletions (M11), completions:
// {name: {argument: [string]}}} | {failed} |
// {timeout}: a module's prompts' arguments derived and compiled at load,
// under the compile budget. promptArgs(key, prompt, args) -> Promise of
// {errors: null | [{instancePath, message, argument?}]} | {failed} | {timeout}: one
// prompts/get's arguments checked, under a check's deadline.
ValidatorPool.prototype.prompts = function(key) {
  if (!this.modules.has(key)) return Promise.resolve({failed: 'the module\'s validation is not loaded'});
  return this.request(key, 'prompts', {type: 'prompts', key: key}, {action: '(prompts)', which: 'input'}, this.compileMs);
};
// promptArgs is a check in every way that bounds a caller: its caller's
// throttle and the module's quarantine apply, its deadline runs from when it
// is queued, and a validator that has not derived the module's prompts
// derives them first, as a check's action is compiled first: past the call's
// deadline that goes on in the background, never a strike or a replacement.
ValidatorPool.prototype.promptArgs = function(key, prompt, args, caller = null) {
  if (!this.modules.has(key)) return Promise.resolve({failed: 'the module\'s validation is not loaded'});
  return this.request(key, 'promptArgs', {type: 'promptArgs', key: key, prompt: prompt, args: args},
    {action: `(prompt ${String(prompt).slice(0, 64)})`, which: 'input', caller: caller}, this.timeoutMs);
};

// A call's deadline runs from when it is queued. A load's own requests (the
// schema safety check, the warm compile) wait for a validator for up to
// LOAD_QUEUE_MAX_MS: a load right after start must not fail because the
// validators are still booting. Their budget then runs from when a validator
// starts them.
const LOAD_QUEUE_MAX_MS = 30000;
// How long a load's request (safety, devicespec, warm) waits for its
// module's home before any free validator takes it.
const LOAD_HOME_WAIT_MS = 1000;
const LOAD_KINDS = new Set(['safety', 'devicespec', 'warm', 'prompts']);
ValidatorPool.prototype.request = function(key, kind, msg, meta, budgetMs) {
  return new Promise((resolve) => {
    // a question waits as a call's check does, and a prompt's arguments
    // check too: a client is waiting on each
    const queueMs = (kind === 'check' || kind === 'question' || kind === 'promptArgs') ? budgetMs : this.loadQueueMs;
    // (one clock read for both: the deadline and the queued time agree)
    const now = Date.now();
    const req = {key: key, kind: kind, msg: Object.assign({id: this.nextId++}, msg), meta: meta, resolve: resolve,
      done: false, slot: null, phase: 'queued', deadlineAt: now + queueMs, budgetMs: budgetMs, timer: null, queuedAt: now,
      // (the queue bound itself, said if it is waited out: never taken back
      // from two clock reads, which may be a millisecond apart; A-flake-qwait)
      queueBoundMs: queueMs};
    req.timer = setTimeout(() => this.onDeadline(req), queueMs);
    // past its wait for its home, a load's request may go anywhere: served then
    if (LOAD_KINDS.has(kind)) setTimeout(() => this.dispatch(), LOAD_HOME_WAIT_MS + 5).unref();
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
  // a serialized check's answer carries its bytes back only when it passed
  if (req.meta != null && req.meta.serialized === true) {
    return req.resolve({refused: answer, buffer: (answer == null && req.returned instanceof ArrayBuffer) ? req.returned : null});
  }
  req.resolve(answer);
};

// The next module to serve: round-robin among the modules holding fewer
// validators than their share (workers - 1). Never more, even when no other
// module is waiting: one that arrives must find a validator free at once.
// The validators a request may be sent to: ready, not ending, and not
// compiling in the background (a call never waits behind a warm-up).
ValidatorPool.prototype.servable = function(slot) {
  return slot.current == null && !slot.ending && !slot.draining && slot.ready && slot.background.size === 0;
};

// A module's share: all but one of the READY validators (the review of #165),
// never fewer than one.
ValidatorPool.prototype.perModuleNow = function() {
  return Math.max(1, this.slots.filter((s) => s.ready && !s.ending && !s.draining).length - 1);
};

// The next request to serve: round-robin among the modules under their
// share, out of cool-down; within a module, the first request whose caller
// has fewer than perCaller validations in flight. -> {key, index} or null.
// A caller whose input stalled a validator in the last STALL_MEMORY_MS
// takes neither the pool's last free validator nor its module's last share:
// while replacements boot, another caller, of that module or another, finds
// one (the review of #165).
ValidatorPool.prototype.nextPick = function(freeSlots) {
  const free = freeSlots.length;
  const now = Date.now();
  const share = this.perModuleNow();
  for (const key of this.order) {
    const queue = this.queues.get(key) || [];
    const busy = this.busy.get(key) || 0;
    if (queue.length === 0 || busy >= share) continue;
    if ((this.cooldown.get(key) || 0) > now) continue;
    // a load's requests wait a little for the module's home
    const homeFree = freeSlots.includes(this.homeOf(key));
    const fits = (r) => {
      if (LOAD_KINDS.has(r.kind) && !homeFree && now - r.queuedAt < LOAD_HOME_WAIT_MS) return false;
      const caller = (r.meta != null) ? r.meta.caller : null;
      if (caller == null) return true;
      if ((this.callerBusy.get(caller) || 0) >= this.perCaller) return false;
      // the module's last share only where it has more than one: a share of
      // one is all it has, and the pool's reserve keeps another module's
      const recent = now - (this.callerStalledAt.get(caller) || -Infinity) < STALL_MEMORY_MS;
      return !(recent && (free <= 1 || (share > 1 && busy >= share - 1)));
    };
    const index = queue.findIndex(fits);
    if (index !== -1) return {key, index};
  }
  return null;
};

// Fairness (nextPick) decides which request starts; homes decide only where:
// on a free validator that has the action compiled already (its home first),
// else on its home when that is free, else on any free one, which compiles
// it on this first check and keeps it. A compile is never paid where one is
// done: after its home was replaced, a module's checks go where it spilled
// until the new home has compiled them.
ValidatorPool.prototype.dispatch = function() {
  for (;;) {
    const free = this.slots.filter((s) => this.servable(s));
    if (free.length === 0) return;
    const pick = this.nextPick(free);
    if (pick == null) return;
    const key = pick.key;
    const queue = this.queues.get(key);
    const req = queue.splice(pick.index, 1)[0];
    if (queue.length === 0) this.queues.delete(key);
    // the module is served: to the back of the round
    this.order = this.order.filter((k) => k !== key);
    if (this.queues.has(key)) this.order.push(key);
    if (req.done) continue;
    // a request that could not be posted, or was answered at once, leaves
    // its slot free: the loop serves on
    this.start(this.placeFor(req, free), req);
  }
};

ValidatorPool.prototype.placeFor = function(req, free) {
  const home = this.homeOf(req.key);
  const homeFree = home != null && free.includes(home);
  const has = (slot) => {
    const c = slot.compiled.get(req.key);
    return c === 'all' || (c != null && req.meta != null && c.has(req.meta.actionId));
  };
  if (homeFree && has(home)) return home;
  return free.find(has) || (homeFree ? home : free[0]);
};

// A serialized check's bytes (msg.buffer) are moved, not copied; never the
// load's.
ValidatorPool.prototype.post = function(slot, msg) {
  const m = this.modules.get(msg.key);
  if (!slot.loaded.has(msg.key)) {
    slot.worker.postMessage({type: 'load', key: msg.key, name: m.name, apiText: m.apiText, schemaText: m.schemaText});
    slot.loaded.add(msg.key);
  }
  if (msg.buffer instanceof ArrayBuffer) return slot.worker.postMessage(msg, [msg.buffer]);
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
  if (m == null) return this.finish(req, notLoadedAnswer(req));
  const checkLike = req.kind === 'check' || req.kind === 'promptArgs';
  if (checkLike && this.quarantined.has(m.name)) return this.finish(req, asReply(quarantinedError(m.name)));
  if (checkLike) {
    const throttled = this.throttledFor(req.meta.caller, m.name, req.meta.action);
    if (throttled != null) return this.finish(req, throttled);
  }
  slot.current = req;
  req.slot = slot;
  if (!checkLike) {
    // a load's request: its budget from now
    clearTimeout(req.timer);
    req.deadlineAt = Date.now() + req.budgetMs;
    req.timer = setTimeout(() => this.onDeadline(req), req.budgetMs);
  }
  this.busy.set(req.key, (this.busy.get(req.key) || 0) + 1);
  const caller = (req.meta != null) ? req.meta.caller : null;
  if (caller != null) this.callerBusy.set(caller, (this.callerBusy.get(caller) || 0) + 1);
  const compiled = slot.compiled.get(req.key);
  if (req.kind === 'promptArgs' && !slot.promptsDerived.has(req.key)) {
    req.phase = 'compile';
    req.compileId = this.nextId++;
    try {
      this.post(slot, {type: 'prompts', id: req.compileId, key: req.key});
    } catch (e) {
      this.release(slot);
      return this.finish(req, {failed: 'unsendable'});
    }
    return;
  }
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
    if (req.kind === 'check') { this.stats.sent++; slot.sent++; }
  } catch (e) {
    // the value cannot be cloned (a function, a Symbol): not validated, and
    // not sendable to the module's worker either
    this.release(slot);
    this.finish(req, req.kind === 'check' ? asReply(CountinghouseError.runtimeReason('DEVICE_INVOKE_EXCEPTION', 'the value could not be sent between threads')) : {failed: 'unsendable'});
    // the slot is free again: the queue goes on (from a compile's answer
    // nothing else would serve it)
    setImmediate(() => this.dispatch());
  }
};

// Every action of `key` compiled in `slot` in the background, with no
// deadline of a call: a compile it has not done or started (a replacement,
// for the modules homed on its slot).
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
    // A replacement compiles the modules homed on its slot in the background,
    // off any call's path (the review of #165), and takes no call until that
    // is done; their checks find another validator meanwhile. The spare
    // warms nothing: it takes a place at once, servable, and compiles that
    // slot's home modules as their checks come. The first validators serve
    // at once.
    if (slot.replacement) {
      const index = this.slots.indexOf(slot);
      for (const [key, m] of this.modules) if (m.home === index) this.backgroundWarm(slot, key);
    }
    return this.dispatch();
  }
  if (msg.type !== 'answer') return;
  if (slot.background.has(msg.id)) {
    const job = slot.background.get(msg.id);
    slot.background.delete(msg.id);
    clearTimeout(job.timer);
    if (msg.failed == null && this.modules.has(job.key) && job.prompts === true) {
      slot.promptsDerived.add(job.key);
    } else if (msg.failed == null && this.modules.has(job.key)) {
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
    if (msg.failed == null && req.kind === 'promptArgs') {
      slot.promptsDerived.add(req.key);
    } else if (msg.failed == null) {
      if (!slot.compiled.has(req.key)) slot.compiled.set(req.key, new Set());
      const set = slot.compiled.get(req.key);
      if (set !== 'all') set.add(req.meta.actionId);
    }
    return this.send(slot, req);
  }
  if (req.msg.id !== msg.id) return;
  this.release(slot);
  if (req.kind === 'safety') {
    // the tools the module's declared text leaves unusable, kept with it
    // for the load to mark (hiddenUnlisted, #400): names only, at most one
    // per action the spec has
    const held = this.modules.get(req.key);
    if (held != null) {
      held.hiddenUnlisted = (msg.failed == null && Array.isArray(msg.hiddenUnlisted))
        ? msg.hiddenUnlisted.filter((p) => Array.isArray(p) && p.length === 2 && typeof(p[0]) === 'string' && typeof(p[1]) === 'string') : [];
    }
    this.finish(req, (msg.failed != null) ? {path: '', reason: `the check failed to run (${String(msg.failed).slice(0, 64)})`} : msg.problem);
  } else if (req.kind === 'devicespec') {
    this.finish(req, (msg.failed != null) ? {specError: {message: `the check failed to run (${String(msg.failed).slice(0, 64)})`, validationErrors: []}}
      : ((msg.specError != null) ? {specError: msg.specError} : null));
  } else if (req.kind === 'warm') {
    if (msg.failed == null) slot.compiled.set(req.key, 'all');
    this.finish(req, (msg.failed != null) ? {failed: String(msg.failed).slice(0, 64)} : null);
  } else if (req.kind === 'question') {
    this.finish(req, (msg.failed != null) ? {failed: String(msg.failed).slice(0, 64)} : (msg.question != null ? msg.question : {schema: null, valid: null}));
  } else if (req.kind === 'prompts') {
    if (msg.failed == null) slot.promptsDerived.add(req.key);
    this.finish(req, (msg.failed != null) ? {failed: String(msg.failed).slice(0, 300)} : {prompts: msg.prompts, completions: msg.completions, resourceCompletions: msg.resourceCompletions});
  } else if (req.kind === 'promptArgs') {
    this.finish(req, (msg.failed != null) ? {failed: String(msg.failed).slice(0, 64)} : {errors: msg.errors});
  } else if (msg.failed != null) {
    this.finish(req, asReply(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', `the module's validation failed to run (${String(msg.failed).slice(0, 64)})`)));
  } else if (msg.refused == null) {
    if (msg.buffer instanceof ArrayBuffer) req.returned = msg.buffer;
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
      this.watchBackground(slot, req.compileId, {key: req.key, actionId: req.meta.actionId, prompts: req.kind === 'promptArgs'});
      return this.refuse(req, 'its action still compiling', false);
    }
    return this.runDeadline(req);
  }
};

// A running request's deadline: judged one turn of this thread's loop later.
// The deadline is a timer here and its clock is the wall's, and timers run
// before messages: after a pause of this thread longer than the deadline (a
// collection, a busy machine), the timer comes first though the validator
// answered long before. Judged at once, that terminated a validator which had
// done its work and struck the module for it. What the validator posted is
// read in between, and so is its end: either has settled the request and
// freed its slot, and there is nothing left to judge (never a second refusal,
// strike or replacement).
ValidatorPool.prototype.runDeadline = function(req) {
  const slot = req.slot;
  setImmediate(() => {
    if (slot.current !== req) return;
    // Started late (its wait in the queue used most of its deadline): it is
    // refused as a wait, never as a stall of its own, and its validator is
    // given a full budget from the start before it counts as stalled.
    const ran = Date.now() - (req.startedAt || Date.now());
    if (!req.done && ran < req.budgetMs) {
      this.refuse(req, 'its wait in the queue', false);
      req.timer = setTimeout(() => this.runDeadline(req), req.budgetMs - ran);
      return;
    }
    this.fail(slot, 'its deadline');
  });
};

// A compile in `slot` with no call waiting on it (a replacement warming its
// slot's home modules, or a spilled check's compile that outlasted the
// check). The module's schemas were compiled within the budget at its load,
// so a slow one here is the machine, never a strike: past the budget it is
// logged, and past three budgets the validator is replaced.
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
// request is refused, then the worker replaced (after a backoff when it keeps
// happening) and the queue served. In that order, since starting a replacement
// can throw (no thread to be had): the request has its answer by then, and the
// queue is served all the same. Each is done whatever the one before it meets.
ValidatorPool.prototype.fail = function(slot, why) {
  const req = slot.current;
  this.release(slot);
  slot.ending = true;
  try {
    const now = Date.now();
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
    } else if (req != null && (req.kind === 'check' || req.kind === 'promptArgs') && req.meta.which === 'input') {
      // an input's (a prompts/get's arguments are one: the review of #321):
      // held against its caller, and nothing else
      const m = this.modules.get(req.key);
      this.callerStalled(req.meta.caller, (m != null) ? m.name : req.key.replace(/#.*$/, ''));
    }
    if (req != null && !req.done) {
      // Its own schema or output: a compile, a warm compile or an output's
      // check. Not an input's (any caller can send one), nor the safety check.
      this.refuse(req, why, ownStall);
    }
  } finally {
    try {
      if (slot.worker != null) slot.worker.terminate().catch(() => {});
      const index = this.slots.indexOf(slot);
      this.respawns.push(Date.now());
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
        // the spare takes the place at once when it is ready (it warms nothing,
        // so it has nothing to finish) and no resize is replacing it; a new spare
        // starts after the backoff
        if (this.spare != null && this.spare.ready && !this.spare.ending && !this.spare.draining && this.spare.background.size === 0) {
          this.slots[index] = this.spare;
          this.spare = this.spawn(delay);
        } else {
          this.slots[index] = this.spawn(delay, true);
        }
      }
    } finally {
      this.dispatch();
    }
  }
};

ValidatorPool.prototype.refuse = function(req, why, strike) {
  const m = this.modules.get(req.key);
  const name = (m != null) ? m.name : req.key.replace(/#.*$/, '');
  // A request refused before any validator started it waited out its queue
  // bound: a call's deadline, or a load's loadQueueMs (30 s). That is the time
  // it was not validated within, never the compile budget it never reached
  // (#327's review: a load refused in the queue said "within 10000 ms").
  const queued = req.phase === 'queued';
  const queueMs = req.queueBoundMs;
  // (one whose validator ended was not timed: no bound is said)
  const whyNot = (ms) => (why === ENDED ? ', because the validator stopped before it answered' : ` within ${ms} ms`);
  if (req.kind === 'warm') {
    const warmMs = queued ? queueMs : this.compileMs;
    LOG.E(new Error(`validator: ${name}: its schemas were not compiled within ${warmMs} ms (${why})`));
    if (strike) this.strike(name);
    return this.finish(req, {timeout: CountinghouseError.withFields('VALIDATION_TIMEOUT', {module: name, action: req.meta.action,
      which: req.meta.which, ms: warmMs, why: whyNot(warmMs)})});
  }
  const ms = queued ? queueMs : (req.kind === 'check' || req.kind === 'question' || req.kind === 'promptArgs') ? this.timeoutMs : this.compileMs;
  const err = CountinghouseError.withFields('VALIDATION_TIMEOUT', {module: name, action: req.meta.action,
    which: req.meta.which, ms: ms, why: whyNot(ms)});
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

// A raise of maxOutputBytes confirmed for this start (part 3 P2, Task 5): a
// validator with the old heap would crash on the bigger value, so each slot
// whose heap is below resourceLimitsFor(maxOutputBytes) is replaced in turn,
// the spare first, then each validator: it takes no new request, its held
// request answers within its own deadline, and its place is taken by the
// (resized) spare when that is ready, or by a replacement, ready and warmed
// before the next slot. Resizes run one at a time; a smaller cap does
// nothing; a resize's replacements are no crash, and never counted in
// respawns or the start backoff. -> Promise, resolved when every slot runs
// at the new limits (or the pool closed).
// A held request is bounded by its own deadline (and a slot that misses it
// is failed and replaced), and a replacement warms within the compile
// budgets; past this a resize stops where it is, never retiring a slot that
// still holds a request or leaving the pool short: what is resized stays
// (a larger heap is harmless), and the raise is not applied.
const RESIZE_SLOT_WAIT_MS = 5 * 60 * 1000;
ValidatorPool.prototype.resize = function(maxOutputBytes) {
  const run = () => this.resizeNow(maxOutputBytes);
  const p = (this.resizing || Promise.resolve()).then(run, run);
  this.resizing = p.catch(() => {});
  return p;
};

ValidatorPool.prototype.resizeNow = async function(maxOutputBytes) {
  const limits = resourceLimitsFor(maxOutputBytes);
  const target = limits.maxOldGenerationSizeMb;
  // every slot started from now on takes the larger limits (a slot started
  // with them is never replaced); the resize is done only when no live slot,
  // the spare included, runs below the target (a resize stopped part way is
  // finished by the next one, never taken as done: the review of #222)
  if (target > this.resourceLimits.maxOldGenerationSizeMb) this.resourceLimits = limits;
  const below = (s) => s != null && !s.ending && s.worker != null && s.limitMb < target;
  if (!below(this.spare) && !this.slots.some(below)) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());
  // -> whether cond came true (or the pool closed)
  const until = async (cond) => {
    for (let w = 0; !this.closed && !cond() && w < this.resizeWaitMs; w += 10) await sleep(10);
    return this.closed || cond();
  };
  const stop = (slot, why) => {
    if (slot != null) slot.draining = false;
    this.dispatch();
    throw Object.assign(new Error(`the validators were not resized: ${why}`), {code: 'RESIZE_STOPPED'});
  };
  const warmedNow = (slot) => slot != null && (slot.ending || (slot.ready && slot.background.size === 0));
  const retire = (slot) => {
    slot.ending = true;
    for (const job of slot.background.values()) clearTimeout(job.timer);
    slot.background.clear();
    if (slot.worker != null) slot.worker.terminate().catch(() => {});
  };
  // its held request answered (or the slot ended on its own: fail() has
  // replaced it at the new limits); one still held at the wait's end stops
  // the resize, and is never terminated by it
  const drained = async (slot) => {
    slot.draining = true;
    if (!(await until(() => slot.current == null || slot.ending))) stop(slot, 'a validator still held its request');
    return !slot.ending && !this.closed;
  };
  // a slot whose start is still pending (a delayed replacement) starts with
  // the limits then in force: nothing to replace
  const pending = (slot) => slot.worker == null && !slot.ending;
  // the spare
  const spare = this.spare;
  if (spare != null && !pending(spare) && spare.limitMb < target && await drained(spare)) {
    if (this.spare === spare) {
      retire(spare);
      this.spare = this.spawn(0);
    }
  }
  if (!(await until(() => warmedNow(this.spare)))) stop(null, 'the spare did not start');
  // each validator
  for (let i = 0; i < this.slots.length && !this.closed; i++) {
    const slot = this.slots[i];
    if (slot == null || pending(slot) || slot.limitMb >= target) continue;
    if (!(await drained(slot)) || this.slots[i] !== slot) continue;
    retire(slot);
    const s = this.spare;
    if (s != null && !s.ending && !s.draining && s.ready && s.background.size === 0 && s.limitMb >= target) {
      this.slots[i] = s;
      this.spare = this.spawn(0);
      this.dispatch();
      if (!(await until(() => warmedNow(this.spare)))) stop(null, 'a new spare did not start');
    } else {
      this.slots[i] = this.spawn(0, true);
      this.dispatch();
      if (!(await until(() => warmedNow(this.slots[i])))) stop(null, 'a replacement did not start');
    }
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
      compileMs: options.validationCompileMs, maxOutputBytes: options.maxOutputBytes, workerOptions: options.getOptionsForWorker()});
  }
  return shared;
}

// A start with modules to load (--loadModule) starts the pool with the
// process (startup levers, (1)): the validators' boot then overlaps the main
// thread's own before it listens, rather than beginning with the first
// module's spec checks, which waited about 1.4 s for it (pack 1, 2 CPUs). A
// start with none starts no validator until one is needed, as before, and so
// does --no-workerThread, where no module's spec is checked in one.
// -> the pool, or null when none was started here.
function startEarly() {
  const dirs = options.localModulePath;
  const some = (typeof(dirs) === 'string' && dirs !== '') || (Array.isArray(dirs) && dirs.length > 0);
  if (!some || options.workerThread !== true || shared != null) return null;
  LOG.I(`validator pool: started with the process, for --loadModule (${options.validatorWorkers} validators and a spare)`);
  return pool();
}

// The shared pool when it has started, else null (a resize has nothing to
// replace: a pool started later takes the options then in force).
function started() { return shared; }

// The shared pool closed and forgotten: the next pool() starts a new one,
// with the options then in force. Never a closed pool left shared: one has
// no validators, so every request after it waits out its queue deadline
// (#321's CI: module-loading 23 closed it, and mcp-contract 24, later in
// the same mocha run, could not load a module's prompts).
function closeShared() {
  if (shared == null) return;
  const was = shared;
  shared = null;
  was.close();
}

// A session's raise of maxOutputBytes (shared runtime B2 Task 2): the shared
// pool grows for the largest effective cap, through resize (which never
// shrinks in release 1). Awaited before the raise applies, so a failed
// resize applies nothing (B2 Task 5). Nothing to grow before the pool starts:
// it is sized from the options when it does.
function growFor(maxOutputBytes) {
  if (shared == null) return Promise.resolve();
  return shared.resize(maxOutputBytes);
}

module.exports = {ValidatorPool, pool, startEarly, started, closeShared, growFor, respawnDelay, defaultValidatorWorkers, homeIndex, STRIKES, STRIKE_WINDOW_MS, CALLER_STALLS, CALLER_COOLDOWN_MS};
