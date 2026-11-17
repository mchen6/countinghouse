// What a module's ctx.redis reaches of a key named as the runtime names a
// task's question record (M22): it reads, then writes over, that name. Its
// namespace puts both under its own prefix, so the record is never touched.
const store = (ctx, op, ...args) => new Promise((resolve) => ctx.redis[op](...args, (e, r) => resolve(e ? {error: String(e.message)} : {value: r})));

module.exports = async (input, ctx) => {
  const read = await store(ctx, 'get', input.key);
  const written = await store(ctx, 'set', input.key, JSON.stringify({pending: {reqKey: 'q-forged'}}));
  return {output: {seen: typeof(read.value) === 'string' ? read.value : null, wrote: written.value === 'OK'}};
};
