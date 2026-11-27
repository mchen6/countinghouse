'use strict';
// A test file that adds jobs in its own process: the identity index set up
// as a running server's holds it -- a secret, and the keys its jobs are
// added with known -- in the describe's before(), and the process's own put
// back in its after() (CLAUDE.md: process-wide state in before()/after()).
// A job names its owner by id, found from the index (B-meter-keys (2)), so
// a key the index doesn't hold would ask an auth provider, which a test
// process hasn't.
//
//   useIdentity(['owner-key-1', 'k'])   // inside a describe
const path = require('path');
const identity = require('../../lib/identity');
const {mkdtemp, remove} = require('./test-tmp');

// (the setup's and the teardown's own bound: mocha gives a hook the timeout
// its suite has when the hook is made, and useIdentity is often called before
// a describe's this.timeout(), so they would run under mocha's default 2 s;
// an initSync and an addKey per key, and a tree removed with retries, are
// synchronous file work a slow Windows runner took past that:
// R-flake-jobs-local-01. Raised only: a larger timeout, or none at all (0,
// --no-timeouts), is kept.)
const SETUP_MS = 30000;
const atLeast = (hook) => { const t = hook.timeout(); if (t !== 0 && t < SETUP_MS) hook.timeout(SETUP_MS); };

function useIdentity(keys) {
  let saved = null;
  let dir = null;
  before(function() {
    atLeast(this);
    saved = identity.stateForTests();
    dir = mkdtemp('ch-identity-scope-');
    identity.initSync({moduleDataPath: dir});
    for (const k of keys) identity.addKey(k, 'test-user', false);
  });
  after(function() {
    atLeast(this);
    if (saved != null) saved.restore();
    if (dir != null) remove(dir);
  });
}

// The same for a child process's script: the lines that set it up there.
// The child's identity directory is made here, in the parent, under
// test/.tmp, and removed when the parent exits: a child killed by a
// timeout leaves nothing behind.
const childDirs = [];
process.on('exit', () => { for (const d of childDirs.splice(0)) remove(d); });
const identityLines = (lib, keys) => {
  const dir = mkdtemp('ch-identity-child-');
  childDirs.push(dir);
  return `
  { const identity = require(${JSON.stringify(path.join(lib, 'identity'))});
    identity.initSync({moduleDataPath: ${JSON.stringify(dir)}});
    for (const k of ${JSON.stringify(keys)}) identity.addKey(k, 'test-user', false); }
`;
};

// A test's stand-in for a runner's authorizeRun that lets every run through:
// it resolves the owner's key from the index, as the real check does (a
// runner refuses an owned job whose key doesn't come back: #518's high, L1).
const authorizedRun = (job) => Promise.resolve(require('../../lib/job-control-common').ownerKeyOf(job != null ? job.data : null));

module.exports = {useIdentity, identityLines, authorizedRun};
