// DELIBERATELY callback-style: a handler that never calls back, so the call
// has to be ended by the device timeout (DEVICE_NOT_RESPONDING).
// Its async twin is testTimeoutAsync.js; converting this one would delete the
// callback-timeout case.
module.exports = (input, ctx, callback) => {
  setTimeout(() => {
    return callback(null, {
      output: {}
    });
  }, 40000);
}
