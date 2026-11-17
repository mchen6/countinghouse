'use strict';
const notes = require('../../store');
module.exports = async (input) => {
  notes.set(input.id, input.text);
  return {output: {saved: true}};
};
