// The two facts about this thread that countinghouse's lazily loaded files
// read: whether it is the main thread, and its id. Taken from worker_threads
// once, when this file loads -- in a lean worker at boot, before set-options
// installs the lockdown, which from then on refuses worker_threads to every
// caller (lib/module-lockdown.js; the reviewer, lean worker step 3, Task 5:
// a file loaded on first use cannot require it then). Two primitives only:
// nothing here hands out a Worker, a port or workerData.
'use strict';

const {isMainThread, threadId} = require('worker_threads');

module.exports = Object.freeze({isMainThread, threadId});
