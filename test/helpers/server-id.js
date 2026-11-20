'use strict';
// An in-process test's server id (lib/server-id.js), set up explicitly: the
// job queue's prefix and job history keys need one, and fail closed without
// (B-j1). useServerId() in a describe: before, an id made in a directory of
// the file's own, unless an earlier file left one (a process-wide id is never
// swapped under a running runner); after, this process has none again.
const serverId = require('../../lib/server-id');
const tmp = require('./test-tmp');

function useServerId() {
  let dir = null;
  before(() => {
    if (serverId.ready()) return;
    dir = tmp.mkdtemp('ch-server-id-');
    serverId.initSync({moduleDataPath: dir});
  });
  after(() => {
    if (dir == null) return;
    serverId.reset();
    tmp.remove(dir);
    dir = null;
  });
}

module.exports = {useServerId};
