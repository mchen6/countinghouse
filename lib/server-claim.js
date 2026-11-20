'use strict';
// One live runtime per server id on a Redis (B-j1, the high review of #463's
// round 2, 3). Two runtimes with one .server-id -- the default data
// directory used by two runtimes of one user, or a directory copied with its
// .server-id (a container image that has one baked in) -- would share one
// job queue, and take each other's jobs: the bug the per-server queue fixes.
// So a runtime claims its id in Redis before its job worker runs: a key
// (chj-claim:<queue prefix>, in the job queue's db) set only if absent, with
// an expiry, renewed by a heartbeat, its value naming the holder (host, pid,
// a nonce, since when). A start that finds the claim held by another live
// holder is refused (lib/job-control.js); one held by an earlier process of
// this host that is gone (a crash, a restart that kept the pid, as a
// container's 1) is taken over. ch-local runs several runtimes on one data
// directory (one per session without the shared-runtime shim), always with
// --store local, whose runner has no Redis queue and makes no claim.
//
// claim(clients, prefix, {onRefused, onLost}) -> {held: Promise, stop()}
//   clients    the store's jobClients (lib/store.js): (db, deadlineMs) -> client
//   held       resolves once the claim is this process's (Redis not answering:
//              tried again every RETRY_MS until it does)
//   onRefused  (holder) another live holder has it: the start is refused
//   onLost     (holder) another took it while Redis was out of reach
//              (said, never the end of a running server)
const os = require('os');
const crypto = require('crypto');

const TTL_MS = 30000;
const RENEW_MS = 10000;
const RETRY_MS = 2000;
const DEADLINE_MS = 3000;
const DB = 11;   // the job queue's (lib/job-control.js)

const keyFor = (prefix) => `chj-claim:${prefix}`;

// renewed if it is ours, taken again if it lapsed, else left: 1 or 0
const RENEW = `local v = redis.call('get', KEYS[1])
if v == ARGV[1] then redis.call('pexpire', KEYS[1], ARGV[2]) return 1 end
if not v then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0`;
// taken over only if it still holds the stale holder's value: 1 or 0
const TAKE_OVER = `if redis.call('get', KEYS[1]) == ARGV[2] then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[3]) return 1 end
return 0`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
return 0`;

// A holder of this host that is gone: its pid answers no signal, or it is
// this very pid (a process before this one, with a nonce of its own).
function gone(holder) {
  if (holder == null || holder.host !== os.hostname()) return false;
  if (holder.pid === process.pid) return true;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

function parse(text) {
  try {
    const v = JSON.parse(String(text));
    return (v != null && typeof(v) === 'object') ? v : null;
  } catch (e) {
    return null;
  }
}

function claim(clients, prefix, {onRefused, onLost} = {}) {
  const client = clients(DB, DEADLINE_MS);
  const cmd = (name, ...args) => new Promise((resolve, reject) => client[name](...args, (e, r) => (e != null ? reject(e) : resolve(r))));
  const key = keyFor(prefix);
  const me = {host: os.hostname(), pid: process.pid, nonce: crypto.randomBytes(8).toString('hex'), since: new Date().toISOString()};
  const value = JSON.stringify(me);
  let stopped = false;
  let timer = null;
  let lostSaid = false;
  const later = (fn, ms) => {
    timer = setTimeout(fn, ms);
    if (typeof(timer.unref) === 'function') timer.unref();
  };
  const heartbeat = () => {
    if (stopped) return;
    cmd('eval', RENEW, 1, key, value, TTL_MS).then((ok) => {
      if (Number(ok) === 1) { lostSaid = false; return null; }
      return cmd('get', key).then((other) => {
        if (!lostSaid && typeof(onLost) === 'function') onLost(parse(other));
        lostSaid = true;
      });
    }, () => { /* Redis out of reach: the next beat tries again */ })
      .catch(() => {})
      .then(() => later(heartbeat, RENEW_MS));
  };
  const held = new Promise((resolve) => {
    const attempt = () => {
      if (stopped) return;
      cmd('set', key, value, 'NX', 'PX', TTL_MS).then((ok) => {
        if (ok === 'OK') return true;
        return cmd('get', key).then((text) => {
          if (text == null) return false;   // it lapsed just now: try again
          const holder = parse(text);
          if (gone(holder)) return cmd('eval', TAKE_OVER, 1, key, value, text, TTL_MS).then((n) => Number(n) === 1);
          stopped = true;
          client.end(true);
          if (typeof(onRefused) === 'function') onRefused(holder);
          return null;
        });
      }).then((got) => {
        if (got === true) { resolve(); later(heartbeat, RENEW_MS); return; }
        if (got === false) { attempt(); return; }
      }, () => later(attempt, RETRY_MS));
    };
    attempt();
  });
  return {
    held,
    key,
    stop() {
      stopped = true;
      clearTimeout(timer);
      return cmd('eval', RELEASE, 1, key, value).catch(() => {}).then(() => client.end(true));
    }
  };
}

module.exports = {claim, keyFor, TTL_MS, RENEW_MS};
