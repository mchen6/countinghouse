// Returns a deliberately wrong output so the framework's own output
// validation is what rejects the call, not the handler.
module.exports = async (input, ctx) => (false);
