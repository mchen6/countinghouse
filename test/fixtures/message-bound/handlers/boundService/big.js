// A message of input.bytes bytes to the main thread, through the worker's own
// channel (module code reaches it through CHUtil.redis.clientInstance).
module.exports = async (input) => new Promise((resolve) => {
  CHUtil.redis.clientInstance.sendRedisCommandToParent({op: 'get', data: ['x'.repeat(input.bytes)]},
    (e) => resolve({output: {error: e ? e.message : null, code: e && e.code ? e.code : null}}));
});
