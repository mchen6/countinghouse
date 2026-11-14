// The two facts about this thread that countinghouse's lazily loaded files
// read: whether it is the main thread, and its id. worker_threads is required
// once, when this file loads -- in a lean worker at boot, before set-options
// installs the lockdown, which from then on refuses worker_threads to every
// caller (lib/module-lockdown.js; the reviewer, lean worker step 3, Task 5:
// a file loaded on first use cannot require it then). Read through getters,
// at call time, so a test that stands in for a worker (redefining
// worker_threads.isMainThread, test/composition/20) is seen. Two primitives
// only: nothing here hands out a Worker, a port or workerData.
'use strict';

const workerThreads = require('worker_threads');

module.exports = Object.freeze({
  get isMainThread() { return workerThreads.isMainThread; },
  get threadId() { return workerThreads.threadId; }
});
