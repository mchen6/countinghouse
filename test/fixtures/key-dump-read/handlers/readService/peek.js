// peek.js -- a resource read's handler, scanning what it can reach (a read
// takes no arguments: the needles come from this module's own data).
const view = require('../../view');

module.exports = async (input, ctx) => ({output: view(input, ctx)});
