'use strict';
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

  // R1 Task 6 (the reviewer's redesign of 11-17): a module's quota shared by
  // its session workers keeps each session's share beside the total, so a
  // session's end gives back exactly what that session was charged. Each
  // session worker's broker charges through its session's view. A share
  // that isn't known (its partition's first walk failed or stopped past the
  // limits) gives nothing back.
  shareOf(sid) {
    if (this.shares == null) this.shares = new Map();
    let share = this.shares.get(sid);
    if (share == null) {
      share = {bytes: 0, entries: 0, known: true};
      this.shares.set(sid, share);
    }
    return share;
  }

  // what a session's broker is given in place of the quota: the same reserve
  // and settle, charged to the total and to the session's share
  viewFor(sid) {
    const quota = this;
    const share = this.shareOf(sid);
    return {
      reserve(bytes, entries, syscall, virtual) {
        quota.reserve(bytes, entries, syscall, virtual);
        share.bytes += bytes;
        share.entries += entries;
      },
      settle(reservedBytes, reservedEntries, actualBytes, actualEntries) {
        quota.settle(reservedBytes, reservedEntries, actualBytes, actualEntries);
        share.bytes = Math.max(0, share.bytes - reservedBytes + actualBytes);
        share.entries = Math.max(0, share.entries - reservedEntries + actualEntries);
      }
    };
  }

  // a partition counted when the quota was first built (one walk per
  // session): usage null (the walk failed) or truncated leaves the share
  // unknown; a truncated walk's count still goes into the total
  addMeasured(sid, usage) {
    const share = this.shareOf(sid);
    if (usage == null || usage.truncated === true) share.known = false;
    if (usage == null) return;
    this.settle(0, 0, usage.bytes, usage.entries);
    share.bytes += usage.bytes;
    share.entries += usage.entries;
  }

  // part of a session's share gone (its /tmp emptied at a respawn): at most
  // what the share holds, and nothing from a share that isn't known
  releasePart(sid, bytes, entries) {
    const share = (this.shares != null) ? this.shares.get(sid) : null;
    if (share == null || !share.known) return false;
    const b = Math.min(bytes, share.bytes);
    const e = Math.min(entries, share.entries);
    share.bytes -= b;
    share.entries -= e;
    this.settle(0, 0, -b, -e);
    return true;
  }

  // a session's partition removed: its whole share leaves the total, and
  // the share is forgotten
  releaseSession(sid) {
    const share = (this.shares != null) ? this.shares.get(sid) : null;
    if (share == null) return false;
    this.shares.delete(sid);
    if (!share.known) return false;
    this.settle(0, 0, -share.bytes, -share.entries);
    return true;
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
