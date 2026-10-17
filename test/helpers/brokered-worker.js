// Runs a test script in a worker whose fs is patched against a broker over a
// fresh tree (root '/data'), or in a plain worker over the same kind of tree
// (root = the real data directory), for the patch and differential tests.
const fs = require('fs');
const path = require('path');
const {Worker} = require('worker_threads');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {FsScheduler} = require('../../lib/fs-broker/scheduler');
const {createBridge} = require('../../lib/fs-broker/server');
const {mkdtemp} = require('./test-tmp');

const ENTRY = path.join(__dirname, 'brokered-worker-entry.js');
const REPO = path.join(__dirname, '..', '..');

async function runBrokered(script, opts) {
  opts = opts || {};
  const usePatch = opts.patch !== false;
  const base = mkdtemp('pw-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  Object.entries(opts.files || {}).forEach(([name, content]) => fs.writeFileSync(path.join(dirs.data, name), content));
  let bridge = null;
  // hostRoots: the repo by default, so the script itself loads by host path (review K1)
  const data = {script: script, root: dirs.data, fsBridge: null, extra: opts.extra || {},
    hostRoots: opts.hostRoots != null ? opts.hostRoots : [fs.realpathSync(REPO)]};
  let transferList = [];
  if (usePatch) {
    const ns = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
    await ns.prepare();
    const scheduler = new FsScheduler({globalCap: 3});
    // enforceFileDecisions: live enforce for one test until plan 3's Task 4 removes the gate
    const broker = new FsBroker({name: 't', mode: opts.mode || 'audit', namespace: ns, cwd: process.cwd(), report: () => {},
      enforceFileDecisions: opts.enforceFileDecisions,
      schedule: (fn) => scheduler.submit('t', fn)});
    bridge = createBridge({broker, scheduler, key: 't'});
    data.fsBridge = bridge.transfer;
    data.root = '/data';
    transferList = bridge.transferList;
  }
  const worker = new Worker(ENTRY, {workerData: data, transferList: transferList});
  try {
    return await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  } finally {
    await worker.terminate();
    if (bridge) await bridge.close();
    fs.rmSync(base, {recursive: true, force: true});
  }
}

module.exports = {runBrokered};
