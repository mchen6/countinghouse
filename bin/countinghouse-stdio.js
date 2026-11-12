#!/usr/bin/env node
'use strict';
// countinghouse over stdio: the entry a client-pack launcher runs (local-mode
// spec §2). Pure JavaScript, no shell and no log pipe, so it runs the same on
// Linux, macOS and Windows: this process becomes the runtime, serving MCP on
// stdin and stdout, with the log on stderr. Every other option is passed
// through to framework.js unchanged.
process.argv.splice(2, 0, '--stdio');
require('../framework.js');
