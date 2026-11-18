// A worker's runtime file that logs through lib/logger.js before anything in
// that worker made a logger (a lean worker makes it at boot since #194's PR
// 1; another worker on the first line logged: lib/peer-worker.js's refusals,
// store's Redis errors) logs that line as the worker's
// (lib/worker-logger.js), never throws for want of one. The main
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

  // as bunyan made it (#194's PR 1 made the worker's logger bunyan-free): an
  // Error first is its message, or the rest when there is a rest; never its
  // stack, which would carry host paths to the main thread's log
  it('an Error first: msg is the rest, or else its message, never the stack', async () => {
    const records = await new Promise((resolve, reject) => {
      const w = new Worker(`
        const {parentPort} = require('worker_threads');
        const WorkerMessage = require(${JSON.stringify(path.join(ROOT, 'lib', 'worker-message.js'))});
        const sent = [];
        WorkerMessage.sendLog = (r) => { sent.push({msg: r.msg, e: r.e}); return true; };
        const LOG = require(${JSON.stringify(path.join(ROOT, 'lib', 'logger.js'))});
        require(${JSON.stringify(path.join(ROOT, 'lib', 'worker-logger.js'))}).createWorkerLogger();
        LOG.logger.warn(new Error('boom'));
        LOG.logger.warn(new Error('boom'), 'said %s', 'otherwise');
        parentPort.postMessage({records: sent});
      `, {eval: true});
      w.on('message', (m) => { if (m != null && m.records != null) { w.terminate(); resolve(m.records); } });
      w.once('error', reject);
    });
    assert.deepStrictEqual(records, [{msg: 'boom', e: 'boom'}, {msg: 'said otherwise', e: 'boom'}]);
  });
});
