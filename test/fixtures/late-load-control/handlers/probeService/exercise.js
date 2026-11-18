// exercise.js -- the late-load probe's control in a validation worker
// (test/sandbox/66): loaded by countinghouse_validate_module, after that
// worker's lockdown, it makes a load with a runtime Module as its parent at
// its top level, which the probe must record there too.
const parent = Object.values(require.cache).find((m) => m != null && typeof(m.filename) === 'string' && /[\\/]lib[\\/]logger\.js$/.test(m.filename));
if (parent != null) { try { module.constructor._load('path', parent); } catch (e) { /* recorded first */ } }

module.exports = async () => ({output: {step: 'control', done: true}});
