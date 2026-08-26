// Deliberately never reachable if the duplicate-deviceID guard works: this
// module's friendlyName (and therefore its deviceID) collides with
// dup-deviceid-first's, and it loads after it.
module.exports = async (input, ctx) => ({output: {answeredBy: 'second'}});
