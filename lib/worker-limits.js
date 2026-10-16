// Main thread: the two limits V8 does not enforce for a worker
// (docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 4). Memory outside the JS heap -- Buffers, typed arrays -- is read
// from worker.getHeapStatistics().external_memory; a blocked event loop is a
// heartbeat that stops coming back. Either way the worker is terminated with
// workerMessage.killReason set, and the exit path in module-manager.js takes
// it from there. The JS heap itself is capped by resourceLimits at spawn.
function watch(worker, workerMessage, limits, opts) {
  // At least two ticks per maxBlockMs, so a block is caught near the limit.
  const intervalMs = (opts != null && opts.intervalMs != null)
    ? opts.intervalMs
    : Math.max(50, Math.min(1000, Math.floor(limits.maxBlockMs / 2)));
  // The ping still waiting for its reply: {since}, or null.
  let pending = null;
  let lastTick = Date.now();
  let stopped = false;

  const kill = (reason) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    workerMessage.killReason = reason;
    worker.terminate();
  };

  const timer = setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    // A late tick means the main thread itself stalled. Timers run before
    // incoming messages, so the reply may already be queued behind this
    // tick: restart its clock rather than blame the worker.
    const stalled = now - lastTick > 2 * intervalMs;
    lastTick = now;
    if (pending != null) {
      if (stalled) pending.since = now;
      else if (now - pending.since > limits.maxBlockMs) return kill('blocked event loop');
    } else {
      const mine = {since: now};
      pending = mine;
      workerMessage.sendSandboxPingMessage(() => { if (pending === mine) pending = null; });
    }
    worker.getHeapStatistics().then((s) => {
      if (s.external_memory > limits.externalMb * 1024 * 1024) kill('external memory limit');
    }, () => { /* the worker is already gone */ });
  }, intervalMs);
  timer.unref();

  worker.once('exit', () => { stopped = true; clearInterval(timer); });
  return function stop() { stopped = true; clearInterval(timer); };
}

module.exports = {watch};
