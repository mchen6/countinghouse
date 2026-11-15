// test/sandbox/54: a module that makes its worker's copy of every call's
// limits huge (the worker's own early check then passes anything), then
// answers n characters. The main thread holds the call to its own cap
// whatever the worker thinks: its limits are main-side state.
const path = require('path');
module.exports = async (input) => {
  try {
    const callLimits = require(path.join(__dirname, '..', '..', '..', '..', '..', 'lib', 'call-limits'));
    const huge = Object.freeze({maxOutputBytes: 2 ** 30, requestTimeout: 2 ** 30});
    callLimits.check = () => huge;
    callLimits.of = () => huge;
    callLimits.forToken = () => huge;
  } catch (e) { /* the lockdown kept it out: the main thread's check is still the one tested */ }
  return {output: {s: 'x'.repeat(input.n)}};
};
