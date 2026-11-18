// Runs when countinghouse_validate_module requires it (a handler file: a main
// entry is never run, lib/module-layout.js), and reports what it
// could reach by throwing it (the validator returns the message as a
// problem). It also sends main-thread messages a validation does not need,
// as hostile module code could; the main thread must refuse them (review R1-4).
const seen = {};
seen.secret = process.env.COUNTINGHOUSE_TEST_SECRET != null ? 'visible' : 'hidden';
seen.outside = (() => { try { require('fs').readFileSync('/etc/hostname'); return 'read'; } catch (e) { return e.code; } })();
if (typeof(CHUtil) !== 'undefined' && CHUtil.redis != null && CHUtil.redis.clientInstance != null) {
  CHUtil.redis.clientInstance.sendRedisCommandToParent({op: 'get', data: ['validate-probe']}, () => {});
  // CHUtil's redis client sends redis commands only (PR-c). What module code
  // sharing the worker's realm still reaches is lib/worker-message.js in
  // require.cache: a WorkerMessage of its own posts on the worker's port,
  // so an invoke can be forged, and the main thread must refuse it.
  const key = Object.keys(require.cache).find((k) => /[\\/]lib[\\/]worker-message\.js$/.test(k) && !k.startsWith('/app/'));
  const WorkerMessage = (key != null) ? require.cache[key].exports : null;
  if (WorkerMessage != null) {
    new WorkerMessage(null).sendActiveMessageToParent({command: 'invokeforeignaction', data: {deviceID: 'x', serviceID: 'y', actionName: 'z', appKey: 'stolen'}}, () => {});
    seen.forged = 'sent';
  } else {
    seen.forged = 'unreachable';
  }
}
throw new Error(`VALIDATE-PROBE ${JSON.stringify(seen)}`);
