'use strict';
// A progress value as every reader takes it (F4-3): a finite number from 0
// to 100. One rule for the worker's posters (lib/countinghouse-util.js) and
// the main thread's handlers (lib/device-manager.js), which never rest on
// the worker's check: module code can post a progress message itself.
const isProgress = (n) => typeof(n) === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;

module.exports = {isProgress};
