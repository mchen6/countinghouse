// A rediscommand message sent on the worker's own channel, naming another
// module in every field a worker could: the main thread must still use the
// name it loaded this module under.
module.exports = async (input) => new Promise((resolve) => {
  const channel = CHUtil.redis.clientInstance;
  channel.sendRedisCommandToParent({op: input.op, data: input.args, module: input.as, moduleName: input.as, hostModuleName: input.as},
    (e, result) => resolve({output: {result: result === undefined ? null : result, error: e ? e.message : null}}));
});
