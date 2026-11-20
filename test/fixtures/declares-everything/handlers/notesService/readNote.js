// Declared as the resource notes/{id}: read with resources/read, and not
// also a tool (MCP completeness M7).
const notes = require('../../store');

module.exports = async (input) => {
  if (!notes.has(input.id)) throw new Error(`no note ${JSON.stringify(input.id)}`);
  return {output: {id: input.id, text: notes.get(input.id)}};
};
