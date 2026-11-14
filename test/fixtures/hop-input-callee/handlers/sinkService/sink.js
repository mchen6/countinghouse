const crypto = require('crypto');
const state = require('../../state.js');
module.exports = async (input) => {
  state.runs++;
  return {output: {length: input.s.length, sha256: crypto.createHash('sha256').update(input.s).digest('hex')}};
};
