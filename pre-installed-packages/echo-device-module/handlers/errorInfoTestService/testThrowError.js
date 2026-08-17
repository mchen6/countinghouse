// DELIBERATELY callback-style: a *synchronous* throw before the handler ever
// calls back. Pinned by test027 as DEVICE_INVOKE_EXCEPTION.
// Its async twin is testThrowErrorAsync.js (test028); converting this one
// would make the two identical and delete the sync-throw case.
module.exports = (input, ctx, callback) => {
  const t = null.toString();
  return callback(null, {
    output: {result: t}
  });
}
