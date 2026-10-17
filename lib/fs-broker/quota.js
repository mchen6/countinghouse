// The per-module disk quota (spec section 3): one pool for /data and /tmp.
// Reserve before growth, settle after with what actually happened. All
// bookkeeping is synchronous, so two operations racing at the edge cannot
// both pass (the main thread runs one at a time). It is approximate in the
// safe direction: two descriptors extending one file at once each measure
// growth from the same old size, so the overlap is counted twice and usage
// drifts up, never down; the next spawn's walk measures it afresh (review I3).
const {nodeError} = require('./errors');

const THRESHOLDS = [0.75, 1];

class Quota {
  constructor(o) {
    this.maxBytes = o.maxBytes;
    this.maxEntries = o.maxEntries;
    this.enforce = o.enforce === true;
    this.reportFn = o.report || (() => {});
    this.bytes = o.bytes || 0;
    this.entries = o.entries || 0;
    this.armed = {diskMb: THRESHOLDS.map(() => true), diskEntries: THRESHOLDS.map(() => true)};
  }

  reserve(bytes, entries, syscall, virtual) {
    if ((bytes > 0 && this.bytes + bytes > this.maxBytes) || (entries > 0 && this.entries + entries > this.maxEntries)) {
      if (this.enforce) throw nodeError('ENOSPC', syscall, virtual);
    }
    this.bytes += bytes;
    this.entries += entries;
    this.crossings();
  }

  settle(reservedBytes, reservedEntries, actualBytes, actualEntries) {
    this.bytes = Math.max(0, this.bytes - reservedBytes + actualBytes);
    this.entries = Math.max(0, this.entries - reservedEntries + actualEntries);
    this.crossings();
  }

  crossings() {
    [['diskMb', this.bytes, this.maxBytes, 'bytes'], ['diskEntries', this.entries, this.maxEntries, 'entries']].forEach(([key, used, max, unit]) => {
      THRESHOLDS.forEach((t, i) => {
        if (this.armed[key][i] && used >= max * t) {
          this.armed[key][i] = false;
          this.reportFn('quota', `${Math.round(t * 100)}% of ${key} (${used} of ${max} ${unit})`);
        } else if (!this.armed[key][i] && used < max * t) {
          this.armed[key][i] = true;
        }
      });
    });
  }
}

module.exports = {Quota};
