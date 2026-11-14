// Lean worker step 3 (test/module-loading/27): ctx.log from a lean worker.
module.exports = async (input, ctx) => { ctx.log({marker: input.marker}); return {output: {}}; };
