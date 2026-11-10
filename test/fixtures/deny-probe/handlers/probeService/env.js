// env.js -- whether the variable is in the worker's environment; never its value.
module.exports = async (input) => ({output: {present: process.env[input.name] !== undefined}});
