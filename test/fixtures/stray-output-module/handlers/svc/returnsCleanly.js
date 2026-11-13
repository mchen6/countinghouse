// Fixture for test/validation/02-stray-output-rejected.js: the declared output only.
module.exports = (input, ctx, callback) => callback(null, {output: {v: input.v}});
