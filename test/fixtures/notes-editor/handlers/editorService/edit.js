'use strict';
module.exports = async (input, ctx) => {
  const r = await ctx.call('notes-notices/notesService.save', {id: input.id, text: input.text});
  return {output: {saved: r.output.saved === true}};
};
