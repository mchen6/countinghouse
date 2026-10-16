// Logs which thread evaluated it, so a test can tell module code that ran in
// the main thread (it must not, under --workerThread) from code that ran in
// the module's own worker. Also the console line the release-mode test
// expects to be silenced: it comes from a dependency, not a handler file.
const isMainThread = require('worker_threads').isMainThread;

console.log(`RELOAD_FIXTURE_DEP_LOADED main=${isMainThread}`);

module.exports = {word: 'hello'};
