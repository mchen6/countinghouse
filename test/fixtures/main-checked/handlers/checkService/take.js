const state = require('../../state.js');

module.exports = async (input) => {
  state.takes++;
  return {output: {n: input.n}};
};
