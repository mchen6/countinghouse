// Main thread: the two limits V8 does not enforce for a worker
// (docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 4). Memory outside the JS heap -- Buffers, typed arrays -- is read
// from worker.getHeapStatistics().external_memory; a blocked event loop is a
// heartbeat that stops coming back. Either way the worker is terminated with
// workerMessage.killReason set, and the exit path in module-manager.js takes
// it from there. The JS heap itself is capped by resourceLimits at spawn.
function watch(worker, workerMessage, limits, opts) {
  const intervalMs = (opts != null && opts.intervalMs != null) ? opts.intervalMs : 1000;
  let lastPong = Date.now();
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
    if (Date.now() - lastPong > limits.maxBlockMs) return kill('blocked event loop');

    workerMessage.sendSandboxPingMessage(() => { lastPong = Date.now(); });
    worker.getHeapStatistics().then((s) => {
      if (s.external_memory > limits.externalMb * 1024 * 1024) kill('external memory limit');
    }, () => { /* the worker is already gone */ });
  }, intervalMs);
  timer.unref();

  worker.once('exit', () => { stopped = true; clearInterval(timer); });
  return function stop() { stopped = true; clearInterval(timer); };
}

module.exports = {watch};
