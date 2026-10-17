// One module's read/write lock: path-resolving operations share it,
// path mutations take it alone, in arrival order, so a module cannot race
// itself between the broker's check and the operation.
class RwLock {
  constructor() {
    this.readers = 0;
    this.writer = false;
    this.queue = [];
  }

  acquire(exclusive) {
    return new Promise((resolve) => {
      this.queue.push({exclusive, resolve});
      this.pump();
    });
  }

  release(exclusive) {
    if (exclusive) this.writer = false; else this.readers--;
    this.pump();
  }

  pump() {
    while (this.queue.length > 0 && !this.writer) {
      const next = this.queue[0];
      if (next.exclusive && this.readers > 0) return;
      this.queue.shift();
      if (next.exclusive) this.writer = true; else this.readers++;
      next.resolve();
      if (next.exclusive) return;
    }
  }
}

module.exports = {RwLock};
