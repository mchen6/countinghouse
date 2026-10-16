// The greeting word comes from a helper this handler require()s, so a reload
// that refreshes only the handler file -- and not what it requires -- keeps
// answering with the old word. test/module-loading/12-reload-fresh-code.js
// edits lib/greeting.js between loads to catch exactly that.
const greeting = require('../../lib/greeting');

module.exports = async (input) => ({
  output: {text: `${greeting.word} ${input.name}`}
});
