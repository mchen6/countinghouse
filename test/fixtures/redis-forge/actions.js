// Module code can reach the worker's channel to the main thread (a documented
// gap), so it can send a rediscommand message with any op itself. The main
// thread must refuse an op that is not a supported command, and its Redis
// client must keep working for everyone (review R1-3).
const within = (ms, p) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);
const send = (op, data) => new Promise((resolve) => {
  CHUtil.redis.clientInstance.sendRedisCommandToParent({op: op, data: data}, (e, r) => resolve(e ? `error: ${e.message}` : `ok: ${JSON.stringify(r)}`));
});

module.exports = {
  forgeService: {
    forge: async (input) => {
      const forged = await within(3000, send(input.op, ['redis-forge:key']));
      const set = await within(3000, new Promise((resolve) => CHUtil.redis.set('redis-forge:key', 'still works', (e) => resolve(e ? `error: ${e.message}` : 'ok'))));
      const after = set !== 'ok' ? `set ${set}`
        : await within(3000, new Promise((resolve) => CHUtil.redis.get('redis-forge:key', (e, v) => resolve(e ? `error: ${e.message}` : v))));
      return {output: {forged: forged, after: after}};
    }
  }
};
