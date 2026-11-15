'use strict';
// Run by test/validation/16 as a mocha child, never by the suite (it is under
// test/fixtures): a server test whose case fails. Its server is started as
// the direct-peer-channels files now start theirs (#234), and must be gone
// once mocha exits. The pid is written to the file the parent names.
const fs = require('fs');
const assert = require('assert');
const {startServer, stopServer} = require('../../helpers/sandbox-server');
const {testPort} = require('../../helpers/test-env');

describe('a server test whose case fails', function() {
  this.timeout(120000);
  let server = null;
  before(async () => {
    server = await startServer(testPort(9791), ['--workerThread', '--debug', '--debugKey', 'left-behind-key']);
    fs.writeFileSync(process.env.LEFT_BEHIND_PID_FILE, String(server.pid));
  });
  after(() => stopServer(server));
  it('fails', () => assert.fail('a failing case, on purpose'));
});
