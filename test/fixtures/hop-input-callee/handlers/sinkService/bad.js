const state = require('../../state.js');
// an output its own schema refuses: a string where an integer is due
module.exports = async () => {
  state.runs++;
  return {output: {length: 'not an integer'}};
};
