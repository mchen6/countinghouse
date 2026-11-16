// The completion action of the note resource's {id} and of the prompt's id:
// {argument, value, context} -> {values}.
const notes = require('../../store');

module.exports = async (input) => ({
  output: {values: [...notes.keys()].filter((id) => id.startsWith(input.value)).sort().slice(0, 100)}
});
