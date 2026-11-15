// Preloaded (NODE_OPTIONS=--require) into test/sandbox/54's own spawned
// runtime only: sets a client call's own cap and timeout by its action's name
// (CH_TEST_CALL_LIMITS: {actionName: {maxOutputBytes?, requestTimeout?}}),
// as the shared runtime's session overrides will; a hop keeps what it takes
// from its caller's token. Nothing in lib/ reads a test switch.
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Session = require(path.join(ROOT, 'lib', 'session'));
const callLimits = require(path.join(ROOT, 'lib', 'call-limits'));
const map = JSON.parse(process.env.CH_TEST_CALL_LIMITS || '{}');
const setDeviceTimer = Session.prototype.setDeviceTimer;
Session.prototype.setDeviceTimer = function(device, callback) {
  // a client's own call (an HTTP request), never a hop's session
  if (this.req != null && Object.prototype.hasOwnProperty.call(map, this.actionName)) {
    this.limits = callLimits.check(Object.assign({}, callLimits.defaults(), map[this.actionName]));
  }
  return setDeviceTimer.call(this, device, callback);
};
