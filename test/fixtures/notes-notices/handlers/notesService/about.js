'use strict';
const notes = require('../../store');
module.exports = async () => ({output: {count: notes.size}});
