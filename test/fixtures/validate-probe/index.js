// Runs when countinghouse_validate_module requires it, and reports what it
// could reach by throwing it (the validator returns the message as a
// problem). It also sends main-thread messages a validation does not need,
// as hostile module code could; the main thread must refuse them (review R1-4).
const seen = {};
seen.secret = process.env.COUNTINGHOUSE_TEST_SECRET != null ? 'visible' : 'hidden';
seen.outside = (() => { try { require('fs').readFileSync('/etc/hostname'); return 'read'; } catch (e) { return e.code; } })();
if (typeof(CHUtil) !== 'undefined' && CHUtil.redis != null && CHUtil.redis.clientInstance != null) {
  const wm = CHUtil.redis.clientInstance;
  wm.sendRedisCommandToParent({op: 'get', data: ['validate-probe']}, () => {});
  if (typeof(wm.sendActiveMessageToParent) === 'function') {
    wm.sendActiveMessageToParent({command: 'invokeforeignaction', data: {deviceID: 'x', serviceID: 'y', actionName: 'z', appKey: 'stolen'}}, () => {});
  }
  seen.forged = 'sent';
}
throw new Error(`VALIDATE-PROBE ${JSON.stringify(seen)}`);
