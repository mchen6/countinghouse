// Declared as a tool and as the static resource "notes".
const notes = require('../../store');

module.exports = async () => ({output: {ids: [...notes.keys()].sort()}});
