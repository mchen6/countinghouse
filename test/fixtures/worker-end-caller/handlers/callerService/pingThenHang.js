// pingThenHang.js -- one hop that completes (billed), then one still in
// flight when worker-end reloads (test/composition/15).
module.exports = async (input, ctx) => {
  await ctx.call('worker-end/endService.ping', {});
  await ctx.call('worker-end/endService.hang', {});
  return {output: {}};
};
