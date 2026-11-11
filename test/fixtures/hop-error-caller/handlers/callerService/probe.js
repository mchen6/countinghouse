// What a ctx.call rejection looks like to the composing module, as data
// (test/composition/17): the same in every mode is the point.
module.exports = async (input, ctx) => {
  try {
    await ctx.call('hop-error-callee/calleeService.fail', {kind: input.kind});
  } catch (e) {
    const details = (e.details != null && typeof(e.details) === 'object') ? e.details : null;
    return {output: {
      name: e.name,
      code: e.code != null ? e.code : null,
      message: e.message,
      origin: e.origin != null ? e.origin : null,
      kind: e.kind != null ? e.kind : null,
      details: details != null && Object.keys(details).length > 0 ? details : null
    }};
  }
  return {output: {resolved: true}};
};
