// RC1-min step 5 (spec section 6): the usage recorder the remote client
// records each server call on: the process's one (lib/usage/runtime.js), or
// the one a test sets.
let injected = null;
function recorder() {
  return (injected != null) ? injected : require('../usage/runtime').usage();
}
function setRecorder(r) { injected = r; }

module.exports = {recorder, setRecorder};
