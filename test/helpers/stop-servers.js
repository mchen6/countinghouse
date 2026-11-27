// Loaded by every mocha run (.mocharc.json): after the last test, every
// server test/helpers/sandbox-server.js started and nothing stopped is
// stopped. Its own exit-time stop runs only when mocha
// calls process.exit (--exit); CI's largest run has no --exit, and there a
// leaked server's pipes would keep the process, and the job, alive. Nothing
// is loaded for a run that never used the helper.
'use strict';
const HELPER = require.resolve('./sandbox-server');

exports.mochaHooks = {
  afterAll() {
    const helper = require.cache[HELPER];
    if (helper != null && typeof helper.exports.stopAll === 'function') helper.exports.stopAll();
  }
};
