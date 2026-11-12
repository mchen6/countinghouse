// Sets input.key to input.value through ctx.redis and reads it back.
module.exports = (input, ctx) => new Promise((resolve, reject) => {
  ctx.redis.set(input.key, input.value, (err) => {
    if (err) return reject(err);
    return ctx.redis.get(input.key, (e2, value) => (e2 ? reject(e2) : resolve({output: {value: value}})));
  });
});
