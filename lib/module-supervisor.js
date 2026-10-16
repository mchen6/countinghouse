// What happens after a module's worker exits unexpectedly -- a resource
// limit kill or a crash (docs/superpowers/specs/2026-10-15-module-sandbox-
// foundation-design.md, section 4): restart with backoff, suspend after
// repeated exits, and answer calls meanwhile with MODULE_RESTARTING or
// MODULE_SUSPENDED instead of an unknown device. Pure apart from the injected
// clock and timers, so the policy is tested on a fake clock
// (test/sandbox/06-supervisor.js). Deliberate exits never reach this: an
// operator action calls clear().
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS  = 60000;
const SUSPEND_AFTER   = 3;
const WINDOW_MS       = 10 * 60 * 1000;

function ModuleSupervisor(opts) {
  opts = opts || {};
  this.now        = opts.now        || Date.now;
  this.setTimer   = opts.setTimer   || setTimeout;
  this.clearTimer = opts.clearTimer || clearTimeout;
  this.restart    = opts.restart;
  this.log        = opts.log        || function() {};
  this.records    = {};   // name -> record
}

ModuleSupervisor.prototype.backoffFor = function(nthExit) {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, nthExit - 1), BACKOFF_MAX_MS);
};

ModuleSupervisor.prototype.recordFor = function(name) {
  if (this.records[name] == null) {
    this.records[name] = {state: 'running', modulePath: null, version: null, exits: [],
                          lastReason: null, nextRestartAt: null, timer: null, specs: {}};
  }
  return this.records[name];
};

ModuleSupervisor.prototype.track = function(name, info) {
  const r = this.recordFor(name);
  r.modulePath = info.modulePath;
  r.version    = info.version;
  r.state      = 'running';
  r.nextRestartAt = null;
  r.specs      = {};
};

ModuleSupervisor.prototype.exited = function(name, reason, deviceSpecs) {
  const r = this.recordFor(name);
  const now = this.now();
  r.exits = r.exits.filter((e) => now - e.at <= WINDOW_MS);
  r.exits.push({at: now, reason: reason});
  r.lastReason = reason;
  r.specs = Object.assign({}, deviceSpecs || {});

  if (r.timer != null) {
    this.clearTimer(r.timer);
    r.timer = null;
  }

  if (r.exits.length >= SUSPEND_AFTER) {
    r.state = 'suspended';
    r.nextRestartAt = null;
    return {action: 'suspend'};
  }

  const delayMs = this.backoffFor(r.exits.length);
  r.state = 'restarting';
  r.nextRestartAt = now + delayMs;
  r.timer = this.setTimer(() => {
    r.timer = null;
    if (r.state === 'restarting') this.restart(name, r);
  }, delayMs);
  return {action: 'restart', delayMs: delayMs, at: r.nextRestartAt};
};

ModuleSupervisor.prototype.clear = function(name) {
  const r = this.records[name];
  if (r == null) return;
  if (r.timer != null) this.clearTimer(r.timer);
  delete this.records[name];
};

ModuleSupervisor.prototype.errorForDevice = function(deviceID) {
  for (const name in this.records) {
    const r = this.records[name];
    if (r.state === 'running' || r.specs[deviceID] == null) continue;
    return {code: r.state === 'suspended' ? 'MODULE_SUSPENDED' : 'MODULE_RESTARTING',
            module: name, reason: r.lastReason, retryAt: r.nextRestartAt};
  }
  return null;
};

ModuleSupervisor.prototype.retainedSpecs = function() {
  const out = {};
  for (const name in this.records) {
    const r = this.records[name];
    if (r.state !== 'running') Object.assign(out, r.specs);
  }
  return out;
};

ModuleSupervisor.prototype.status = function(name) {
  const r = this.records[name];
  if (r == null) return null;
  return {state: r.state, lastReason: r.lastReason, exits: r.exits.slice(), nextRestartAt: r.nextRestartAt};
};

ModuleSupervisor.BACKOFF_BASE_MS = BACKOFF_BASE_MS;
ModuleSupervisor.BACKOFF_MAX_MS  = BACKOFF_MAX_MS;
ModuleSupervisor.SUSPEND_AFTER   = SUSPEND_AFTER;
ModuleSupervisor.WINDOW_MS       = WINDOW_MS;

module.exports = ModuleSupervisor;
