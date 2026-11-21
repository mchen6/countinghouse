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

function useIdentity(keys) {
  let saved = null;
  let dir = null;
  before(() => {
    saved = identity.stateForTests();
    dir = mkdtemp('ch-identity-scope-');
    identity.initSync({moduleDataPath: dir});
    for (const k of keys) identity.addKey(k, 'test-user', false);
  });
  after(() => {
    if (saved != null) identity.restoreForTests(saved);
    if (dir != null) remove(dir);
  });
}

// The same for a child process's script: the lines that set it up there.
const identityLines = (lib, keys) => `
  { const identity = require(${JSON.stringify(path.join(lib, 'identity'))});
    require('fs').mkdirSync(${JSON.stringify(path.join(__dirname, '..', '.tmp'))}, {recursive: true});
    const dir = require('fs').mkdtempSync(require('path').join(${JSON.stringify(path.join(__dirname, '..', '.tmp'))}, 'ch-identity-child-'));
    process.on('exit', () => require('fs').rmSync(dir, {recursive: true, force: true}));
    identity.initSync({moduleDataPath: dir});
    for (const k of ${JSON.stringify(keys)}) identity.addKey(k, 'test-user', false); }
`;

module.exports = {useIdentity, identityLines};
