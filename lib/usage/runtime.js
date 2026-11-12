// The process's one usage recorder (local-mode spec §5), created on first use
// with --usageDir. The gateway begins and ends every tools/call on it, and the
// remote client (A's lib/remote/) records each server call on it:
//   require('./usage/runtime').usage().recordIn(call, {...})
const {createUsage} = require('./index');
const options = require('../cli-options');

let recorder = null;
function usage() {
  if (recorder == null) recorder = createUsage({usageDir: options.usageDir || null});
  return recorder;
}

module.exports = {usage};
