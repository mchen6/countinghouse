// DELIBERATELY callback-style: throws inside a detached setTimeout, i.e.
// after the handler has already returned. Pinned by test029 as
// DEVICE_NOT_RESPONDING -- nothing can catch it, so the call times out.
// Its async twin is testAsyncThrowInAsync.js (test030).
module.exports = (input, ctx, callback) => {
  setTimeout(() => {
    const t = null.toString();
    return callback(null, {
      output: {}
    });
  }, 1000);
}
