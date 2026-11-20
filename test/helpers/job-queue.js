'use strict';
// The BullMQ prefix a runtime's job queue is under (B-j1: its own, derived
// from its identity secret; lib/job-control-common.js jobQueuePrefix), worked
// out here as the runtime does, from the secret in its module data directory
// (or COUNTINGHOUSE_IDENTITY_SECRET), so a test can open that server's queue
// and no other. dataDir: the --moduleDataPath the runtime was given (the
// default, $HOME/.countinghouse/module_data, when none). Read once the
// runtime is up: it makes the secret at its first start.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {JOB_QUEUE_LABEL, queuePrefixFrom} = require('../../lib/job-control-common');
// (the runtime's own derivation, never a copy of it)
const {deriveFrom} = require('../../lib/identity');

function prefixForSecret(hex) {
  return queuePrefixFrom(deriveFrom(Buffer.from(hex, 'hex'), JOB_QUEUE_LABEL));
}

function prefixFor(dataDir = null) {
  const fromEnv = process.env.COUNTINGHOUSE_IDENTITY_SECRET;
  if (fromEnv != null && fromEnv !== '') return prefixForSecret(fromEnv);
  const home = process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'] || os.homedir();
  const dir = dataDir != null ? dataDir : path.join(home, '.countinghouse', 'module_data');
  return prefixForSecret(fs.readFileSync(path.join(dir, '.identity-secret'), 'utf8').trim());
}

module.exports = {prefixFor, prefixForSecret};
