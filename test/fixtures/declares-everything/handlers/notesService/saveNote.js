// Declares the question "overwrite". It is asked once ctx.ask exists (M13);
// until then a save replaces what was there.
const notes = require('../../store');

module.exports = async (input) => {
  notes.set(input.id, input.text);
  return {output: {saved: true}};
};
