// flood.js -- many Redis commands at once, each a message to the main thread;
// with a low --moduleMessageRate most come back RATE_LIMITED.
module.exports = async () => {
  const total = 500;
  const results = await Promise.all(Array.from({length: total}, () => new Promise((resolve) => {
    CHUtil.redis.get('sandbox-hog-flood', (err) => resolve(err != null && err.code === 'RATE_LIMITED'));
  })));
  return {output: {limited: results.filter(Boolean).length, total: total}};
};
