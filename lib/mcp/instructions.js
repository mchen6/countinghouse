'use strict';
// The server's instructions (B-firstrun: the first-run design, (a); Matt's
// approval 2026-11-20, business's claim check): one fixed English
// paragraph, versioned with the runtime, the same for every caller, sent on
// initialize and on server/discover. Fixed on purpose: discover is cached
// public (the same answer for everyone), initialize resolves no caller and
// may answer before the modules load, and fixed runtime text carries no
// module-supplied text a client would have to clean. What is installed is
// countinghouse_overview's (lib/overview.js). Pinned word for word by
// test/mcp-contract/41-instructions.js: a change is a business review.
const INSTRUCTIONS = 'This is countinghouse, a runtime that serves the tools of the modules installed on it. '
  + 'To learn what is installed here, what each pack does, example requests and anything still missing, call countinghouse_overview; it changes nothing. '
  + 'Where countinghouse_settings is offered, it reads and changes settings within their bounds. '
  + 'Turning a module on or loosening a limit needs the user\'s own confirmation; ask the user before changing any setting. '
  + 'Never ask the user for a credential, key or token, and never accept one in the conversation: '
  + 'when a module needs one, the overview names the command the user runs in their own terminal.';

module.exports = {INSTRUCTIONS};
