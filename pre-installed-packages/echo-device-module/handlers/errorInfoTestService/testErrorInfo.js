// DELIBERATELY callback-style, and must stay that way until 7.0.0.
//
// It is the only coverage of `callback(err)` with an untyped error, which
// resolves to DEVICE_INVOKE_FAIL. Rewriting it as `throw new Error(...)`
// would resolve to DEVICE_INVOKE_EXCEPTION instead -- a different code, by
// design (see docs/design-decisions.md, "Handler failure is classified by the
// error, not by how it arrived") -- and would break test014/015/016 while
// deleting the last check that the deprecated contract still works.
//
// Its async twin is testErrorInfoAsync.js. The pair is the point.
module.exports = (input, ctx, callback) => {
  if (input.foo === '111') return callback(null, {output: {result: true}});
  
  if (input.foo === '222') return callback(new Error('error'), {fault: {reason: 'err', info :input.foo}});
  if (input.foo === '333') return callback(new Error('error'), input.foo);
  return callback(new Error('unknown error'));
}
