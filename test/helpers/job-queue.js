'use strict';
// The BullMQ prefix a runtime's job queue is under (B-j1: its own, named by
// its server id; lib/job-control-common.js jobQueuePrefix), from the id the
// runtime keeps beside its data, read by the runtime's own reader
// (lib/server-id.js read: its directory, its checks), so a test can open
// that server's queue and no other. options: the runtime's
// {moduleDataPath, storePath, singleIdentity}, or its --moduleDataPath as a
// string; none: the default ($HOME/.countinghouse/module_data). Read once the
// runtime is up: it makes the id at its first start.
const {queuePrefixFrom} = require('../../lib/job-control-common');
const serverId = require('../../lib/server-id');
const {defaultModuleDataPath} = require('../../lib/cli-options');

function prefixFor(options = null) {
  const given = typeof(options) === 'string' ? {moduleDataPath: options} : options;
  const id = serverId.read(given != null ? given : {moduleDataPath: defaultModuleDataPath()});
  if (id == null) throw new Error('job-queue helper: the runtime has no server id there yet (is it up?)');
  return queuePrefixFrom(id);
}

module.exports = {prefixFor};
