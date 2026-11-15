// A worker's runtime file that logs through lib/logger.js before anything in
// that worker made a logger (a lean worker makes it on the first line logged:
// lib/peer-worker.js's refusals, store's Redis errors) logs that line as the
// worker's (lib/worker-logger.js), never throws for want of one. The main
// thread is unchanged: it makes its logger at start.
const assert = require('assert');
const path = require('path');
const {Worker} = require('worker_threads');

const ROOT = path.join(__dirname, '..', '..');

function inWorker(code) {
  return new Promise((resolve, reject) => {
    const w = new Worker(`
      const {parentPort} = require('worker_threads');
      const out = {threw: null, made: false};
      try {
        const LOG = require(${JSON.stringify(path.join(ROOT, 'lib', 'logger.js'))});
        ${code}
        out.made = LOG.logger != null;
      } catch (e) {
        out.threw = String(e && e.message);
      }
      parentPort.postMessage({result: out});
    `, {eval: true});
    // the worker's log records arrive here too (as envelopes): the result
    // is the one message that says so
    w.on('message', (m) => { if (m != null && m.result != null) { w.terminate(); resolve(m.result); } });
    w.once('error', reject);
  });
}

describe('module-loading 29: a worker logs without a logger made first', function() {
  this.timeout(20000);

  it('E, W, I and DE through lib/logger.js make the worker\'s logger and do not throw', async () => {
    const out = await inWorker(`
      LOG.E(new Error('first line'));
      LOG.W('a warning');
      LOG.I('a line');
      LOG.DE({spec: {device: {friendlyName: 'x'}}}, new Error('device error'));
    `);
    assert.deepStrictEqual(out, {threw: null, made: true});
  });
});
