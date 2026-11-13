// Fixture for test/validation/02-stray-output-rejected.js: the declared
// output, plus an argument the spec knows nothing about.
module.exports = (input, ctx, callback) => callback(null, {output: {v: input.v}, surprise: 'undeclared'});
