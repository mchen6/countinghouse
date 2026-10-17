// Shares the libuv threadpool between module workers (docs/superpowers/
// specs/2026-10-17-module-sandbox-fs-broker-design.md, section 3): a global
// cap on brokered operations in flight, round-robin across workers, at most
// perWorkerWhenContended for one worker while another waits, and a bounded
// queue per worker (EMFILE past it, which graceful-fs and its kind retry).
const {nodeError} = require('./errors');

class FsScheduler {
  static capFor(size) {
    return Math.max(1, Math.floor((Number(size) || 0) * 3 / 4));
  }

  constructor(opts) {
    this.globalCap = opts.globalCap;
    this.perWorker = opts.perWorkerWhenContended || 2;
    this.queueCap = opts.queueCap || 4096;
    this.queues = new Map();     // key -> [{task, resolve, reject}]
    this.active = new Map();     // key -> count
    this.running = 0;
    this.order = [];             // round-robin rotation of keys
  }

  submit(key, task) {
    let q = this.queues.get(key);
    if (q == null) { q = []; this.queues.set(key, q); this.order.push(key); }
    if (q.length >= this.queueCap) return Promise.reject(nodeError('EMFILE', 'queue'));
    return new Promise((resolve, reject) => {
      q.push({task, resolve, reject});
      this.pump();
    });
  }

  forget(key) {
    const q = this.queues.get(key) || [];
    this.queues.delete(key);
    this.order = this.order.filter((k) => k !== key);
    q.forEach((item) => item.reject(nodeError('EIO', 'queue')));
  }

  waitingOthers(key) {
    for (const [k, q] of this.queues) if (k !== key && q.length > 0) return true;
    return false;
  }

  pump() {
    let progressed = true;
    while (this.running < this.globalCap && progressed) {
      progressed = false;
      for (let i = 0; i < this.order.length && this.running < this.globalCap; i++) {
        const key = this.order[0];
        this.order.push(this.order.shift());
        const q = this.queues.get(key);
        if (q == null || q.length === 0) continue;
        const act = this.active.get(key) || 0;
        if (act >= this.perWorker && this.waitingOthers(key)) continue;
        const item = q.shift();
        this.active.set(key, act + 1);
        this.running++;
        progressed = true;
        Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
          this.running--;
          this.active.set(key, (this.active.get(key) || 1) - 1);
          this.pump();
        });
      }
    }
  }
}

module.exports = {FsScheduler};
