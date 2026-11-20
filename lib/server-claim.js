'use strict';
// One live runtime per server id on a Redis (B-j1, the high review of #463's
// round 2, 3). Two runtimes with one .server-id -- the default data
// directory used by two runtimes of one user, or a directory copied with its
// .server-id (a container image that has one baked in) -- would share one
// job queue, and take each other's jobs: the bug the per-server queue fixes.
// So a runtime claims its id in Redis before its job worker runs: a key
// (chj-claim:<queue prefix>, in the job queue's db) set only if absent, with
// an expiry (ttlMs), renewed by a heartbeat (every renewMs), its value
// naming the holder (host, pid, a nonce, since when).
//
// A claim held already is taken over at once when its holder is of this
// host and this pid namespace (/proc/self/ns/pid on Linux; none elsewhere)
// and its pid is gone: a crash, a kill, a restart. Otherwise it is watched
// for one heartbeat and a little more: a holder that renews it is alive, and
// the start is refused (onRefused); one that does not is gone (a pod
// replaced, a container restarted), and the claim is taken over. A host
// name and a pid alone are never proof of anything: two containers can
// share both (--hostname, host networking, each one's pid 1), which is why
// the namespace must match too, and why this very pid is watched, never
// taken. (The medium review of #463's round 2.)
//
// ch-local runs several runtimes on one data directory (one per session
// without the shared-runtime shim), always with --store local, whose runner
// has no Redis queue and makes no claim.
//
// claim(clients, prefix, {onRefused, onLost, onRegained, ...timings})
//   -> {held, decided, stop()}
//   clients     the store's jobClients (lib/store.js): (db, deadlineMs) -> client
//   held        resolves once the claim is this process's
//   decided     resolves once it is held, or at once when Redis does not
//               answer (the start goes on; the worker waits for held); a
//               refusal calls onRefused instead (the start's end)
//   onLost      (holder) the heartbeat found another holder (it took the
//               claim while this one's lapsed): the worker pauses
//   onRegained  () the claim is this one's again: the worker resumes
const os = require('os');
const crypto = require('crypto');

const TTL_MS = 30000;
const RENEW_MS = 10000;
const RETRY_MS = 2000;
const DEADLINE_MS = 3000;
// a holder is watched for a heartbeat and this much more
const WATCH_SLACK_MS = 2000;

const keyFor = (prefix) => `chj-claim:${prefix}`;

// this process's pid namespace, where there is one to name
function pidNamespace() {
  try { return require('fs').readlinkSync('/proc/self/ns/pid'); } catch (e) { return null; }
}
// a holder of this host and pid namespace whose pid is gone (and is not
// this process: a pid seen again is never proof)
function goneHere(holder, ns) {
  if (holder == null || holder.host !== os.hostname() || (holder.pidns || null) !== ns) return false;
  if (!Number.isInteger(holder.pid) || holder.pid <= 0 || holder.pid === process.pid) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

// renewed if it is ours, taken again if it lapsed, else left: 1 or 0
const RENEW = `local v = redis.call('get', KEYS[1])
if v == ARGV[1] then redis.call('pexpire', KEYS[1], ARGV[2]) return 1 end
if not v then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0`;
// taken over only if it still holds the watched holder's value: 1 or 0
const TAKE_OVER = `if redis.call('get', KEYS[1]) == ARGV[2] then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[3]) return 1 end
return 0`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
return 0`;

function parse(text) {
  try {
    const v = JSON.parse(String(text));
    return (v != null && typeof(v) === 'object') ? v : null;
  } catch (e) {
    return null;
  }
}

function claim(clients, prefix, {onRefused, onLost, onRegained, ttlMs = TTL_MS, renewMs = RENEW_MS, retryMs = RETRY_MS, watchSlackMs = WATCH_SLACK_MS} = {}) {
  const client = clients(require('./store').JOB_QUEUE_REDIS_DB, DEADLINE_MS);
  // Until the claim is decided its connection keeps the process up: a start
  // waits for the decision before it serves, with nothing else to hold it.
  // After, it never does: a server is kept up by what it serves, and a
  // process whose work is done (a test run's) exits with its claim still
  // held, which lapses (the heartbeat's timer is unref'd too).
  const letGo = () => { if (typeof(client.unref) === 'function') client.unref(); };
  const key = keyFor(prefix);
  const ns = pidNamespace();
  const value = JSON.stringify({host: os.hostname(), pid: process.pid, pidns: ns, nonce: crypto.randomBytes(8).toString('hex'), since: new Date().toISOString()});
  let stopped = false;
  let timer = null;
  let lost = false;
  const later = (fn, ms) => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
    if (typeof(timer.unref) === 'function') timer.unref();
  };
  const wait = (ms) => new Promise((resolve) => later(resolve, ms));
  let decide = null;
  const decided = new Promise((resolve) => { decide = resolve; }).then(letGo);
  const heartbeat = () => {
    if (stopped) return;
    client.cmd('eval', RENEW, 1, key, value, ttlMs).then((ok) => {
      if (Number(ok) === 1) {
        if (lost) { lost = false; if (typeof(onRegained) === 'function') onRegained(); }
        return null;
      }
      if (lost) return null;
      lost = true;
      return client.cmd('get', key).then((other) => { if (typeof(onLost) === 'function') onLost(parse(other)); });
    }, () => { /* Redis out of reach: the next beat tries again */ })
      .catch(() => {})
      .then(() => { if (!stopped) later(heartbeat, renewMs); });
  };
  // -> true held, false look again, null refused
  const watchHolder = () => Promise.all([client.cmd('get', key), client.cmd('pttl', key)]).then(([v0, p0]) => {
    if (v0 == null) return false;
    if (goneHere(parse(v0), ns)) return client.cmd('eval', TAKE_OVER, 1, key, value, v0, ttlMs).then((n) => Number(n) === 1);
    const t0 = Date.now();
    return wait(renewMs + watchSlackMs).then(() => Promise.all([client.cmd('get', key), client.cmd('pttl', key)])).then(([v1, p1]) => {
      if (v1 == null || v1 !== v0) return false;   // gone, or changed hands: look again
      const elapsed = Date.now() - t0;
      // renewed: its time to live went up again (a lapse alone only counts down)
      if (Number(p1) > Number(p0) - elapsed + watchSlackMs / 2) {
        stopped = true;
        client.end(true);
        if (typeof(onRefused) === 'function') onRefused(parse(v1));
        return null;
      }
      return client.cmd('eval', TAKE_OVER, 1, key, value, v0, ttlMs).then((n) => Number(n) === 1);
    });
  });
  const held = new Promise((resolve) => {
    const attempt = () => {
      if (stopped) return;
      client.cmd('set', key, value, 'NX', 'PX', ttlMs)
        .then((ok) => (ok === 'OK' ? true : watchHolder()))
        .then((got) => {
          if (got === true) { decide(); resolve(); later(heartbeat, renewMs); return; }
          if (got === false) attempt();
        }, () => {
          // Redis not answering: the start goes on, and this tries again
          decide();
          if (!stopped) later(attempt, retryMs);
        });
    };
    attempt();
  });
  return {
    held,
    decided,
    key,
    stop() {
      stopped = true;
      clearTimeout(timer);
      return client.cmd('eval', RELEASE, 1, key, value).catch(() => {}).then(() => client.end(true));
    }
  };
}

module.exports = {claim, keyFor, TTL_MS, RENEW_MS};
