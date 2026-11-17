'use strict';
// the request's context says how to answer: throw, answer no values, take
// too long (and then make a request of its own, whose answer is kept for
// lastLate), or answer two ids
module.exports = async (input, ctx) => {
  const mode = (input.context != null && input.context.arguments != null) ? input.context.arguments.mode : undefined;
  if (mode === 'boom') throw new Error('this completion fails');
  if (mode === 'bad') return {output: {nothing: true}};
  if (mode === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    global.__lateUsage = await ctx.usage().then(() => 'answered', (e) => String((e && e.code) || 'refused'));
    return {output: {values: ['too-late']}};
  }
  return {output: {values: ['item-1', 'item-2']}};
};
