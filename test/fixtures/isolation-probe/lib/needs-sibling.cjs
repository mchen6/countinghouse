// A CommonJS file reached by import() that requires a sibling by a relative
// name with no extension: on Node 22.16 and 24.0 Node resolves it through
// the import conditions, and it must still be a require (the review of
// e0f39de9)
module.exports = {own: require('./sibling').own};
