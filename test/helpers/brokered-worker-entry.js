// Worker entry for test/helpers/brokered-worker.js: optionally installs the
// fs patch first (as lib/lean-worker.js does), then runs a test script.
const {workerData, parentPort} = require('worker_threads');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib', 'fs-broker');

(async () => {
  const ctx = {consoleLines: []};
  const fh = await require('fs/promises').open(__filename);
  ctx.realFileHandleKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(fh));
  await fh.close();
  ctx.extra = workerData.extra || {};
  if (workerData.fsBridge != null) {
    ctx.patch = require(path.join(LIB, 'patch'));
    ctx.handled = ctx.patch.install(require(path.join(LIB, 'client')).createClient(workerData.fsBridge),
      {consoleWrite: (fd, buf) => ctx.consoleLines.push(`${fd}:${Buffer.from(buf).toString()}`)});
  }
  // The script and what it requires load from the repo under a boot grant,
  // as countinghouse's own code does before set-options (lib/lean-worker.js).
  const releaseBoot = ctx.handled != null ? ctx.handled.grant.boot([workerData.repo]) : () => {};
  let run;
  try { run = require(workerData.script); } finally { releaseBoot(); }
  return run(require('fs'), workerData.root, ctx);
})().then((r) => parentPort.postMessage({ok: true, r: r}),
  (e) => parentPort.postMessage({ok: false, e: {code: e && e.code, message: String(e && e.message), stack: String(e && e.stack)}}));
