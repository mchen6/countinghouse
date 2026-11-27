'use strict';
// Redis clients and rate limiters that answer while Redis is down (review
// M5), for metering (the balance ledger) and rate limiting.
//
// node_redis 3.1.2's defaults (node_modules/redis/index.js) suit neither:
// - enable_offline_queue: a command issued while disconnected waits in
//   memory until Redis is back, so its callback does not fire for the length
//   of the outage. A rate-limit check then holds its request open instead of
//   failing open, and a charge queued in the outage lands when Redis returns.
//   Here the queue serves only the first connect: code that issues a command
//   right after creating a client still works. It is turned off at the first
//   'ready' (node_redis reads enable_offline_queue at call time), or after
//   FIRST_CONNECT_MS if Redis is not there yet, failing what was queued, so a
//   server started with Redis down still answers promptly. From then on a
//   command fails at once while disconnected.
// - connect_timeout (default 1 h) also caps one outage's reconnect attempts
//   in total; past it the client ends for good (index.js:580) and metering
//   never resumes. Here the retry strategy resets that running total on each
//   attempt (a field of this pinned, unmaintained version: retry_totaltime)
//   and waits at most MAX_RETRY_DELAY_MS between attempts, so the client
//   reconnects however long Redis was down.
// A command already sent when Redis stops answering (hung, not down) is not
// covered by the above. A client made with {commandDeadlineMs} fails each
// command that has not answered by then (REDIS_COMMAND_TIMEOUT; its late
// reply is dropped), so every part on it answers within a bounded time
// (the Reviewer's high review of #443, 1). withDeadline is the one helper
// for an operation of several commands, or a library's own call (the rate
// limiter, the nonce store, the blob store).
const redis = require('redis');
const RollingRateLimiter = require('rolling-rate-limiter');
const {meterId} = require('./key-fingerprint');

const MAX_RETRY_DELAY_MS = 1000;
const RATE_LIMIT_DEADLINE_MS = 500;
const FIRST_CONNECT_MS = 2000;

function retryDelay(attempt) {
  return Math.min(100 * attempt, MAX_RETRY_DELAY_MS);
}

// (lib/with-deadline.js: a helper that makes no client, so the blob store
// takes it from there and names no Redis module: store 02)
const withDeadline = require('./with-deadline');

const DEADLINED = Symbol('countinghouse.redisDeadline');
// node_redis' own connect-time commands: it sends its INFO ready check and
// AUTH with ready set true for the moment (index.js ready_check), so they
// are told apart by name; no part of ours sends these
const CONNECT_COMMANDS = new Set(['info', 'auth', 'select', 'client']);
const commandTimeout = (command, ms) => Object.assign(new Error(`Redis did not answer ${String(command).toUpperCase()} within ${ms} ms`), {code: 'REDIS_COMMAND_TIMEOUT'});

// firstConnectMs: tests only. extra.commandDeadlineMs: each command's
// deadline (none by default: metering's client keeps its own bounds).
function createClient(url, opts, firstConnectMs, {commandDeadlineMs = 0} = {}) {
  let client = null;
  client = redis.createClient(url, Object.assign({}, opts, {
    enable_offline_queue: true,
    retry_strategy: (params) => {
      if (client != null) client.retry_totaltime = 0;
      return retryDelay(params.attempt);
    }
  }));
  const queueOff = () => {
    clearTimeout(timer);
    if (client.enable_offline_queue === false) return;
    client.enable_offline_queue = false;
    if (client.offline_queue.length > 0) {
      client.flush_and_error({message: 'Redis was not reachable when this client started.', code: 'NR_CLOSED'},
        {queues: ['offline_queue']});
    }
  };
  // node_redis drains the offline queue in on_ready, before it emits
  // 'ready' (so with the queue still on, on a first connect): a command sent
  // there while the stream is not writable -- Redis closed the connection as
  // it answered the ready check -- is pushed back onto the same queue, and
  // its loop shifts it again, forever, on the main thread (R-redis-drop-spin).
  // This client drains a snapshot: a command put back waits in a new queue,
  // which is answered NR_CLOSED (queueOff) here, never left to a 'ready' that
  // may not follow (on_ready's subscription branch emits none). Pinned to
  // node_redis 3.1.x by store 10.
  client.send_offline_queue = function() {
    const pending = this.offline_queue;
    this.offline_queue = new pending.constructor();
    for (let command = pending.shift(); command != null; command = pending.shift()) this.internal_send_command(command);
    if (this.offline_queue.length > 0) queueOff();
    this.drain();
  };
  const timer = setTimeout(queueOff, firstConnectMs != null ? firstConnectMs : FIRST_CONNECT_MS);
  if (typeof(timer.unref) === 'function') timer.unref();
  client.once('ready', queueOff);
  if (commandDeadlineMs > 0) {
    // every command node_redis sends with a callback goes through here
    // (index.js internal_send_command): its callback answers once, with the
    // reply or REDIS_COMMAND_TIMEOUT. Only a command sent while the client
    // is ready: never node_redis' own connect-time commands (its INFO ready
    // check, SELECT), which a timeout would leave never ready; and a command
    // only once, though the offline queue sends it again (the medium on
    // #443's high round, 1 and 8).
    const send = client.internal_send_command;
    client.internal_send_command = function(command) {
      if (command != null && typeof(command.callback) === 'function' && this.ready === true && command[DEADLINED] !== true &&
          !CONNECT_COMMANDS.has(String(command.command).toLowerCase())) {
        command[DEADLINED] = true;
        const answer = command.callback;
        let done = false;
        const t = setTimeout(() => {
          if (done) return;
          done = true;
          answer(commandTimeout(command.command, commandDeadlineMs));
        }, commandDeadlineMs);
        if (typeof(t.unref) === 'function') t.unref();
        command.callback = (err, reply) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          answer(err, reply);
        };
      }
      return send.call(this, command);
    };
  }
  return client;
}

// rolling-rate-limiter with a deadline on each check (withDeadline): the
// callback is called exactly once. When Redis cannot answer (down, or no
// answer within the deadline) the check is decided by the same limit kept in
// this process's memory, never "allowed" for want of an answer: a key's
// calls stay bounded while Redis is out (the Reviewer on #443: a timeout
// must not become unlimited calls for a key). Per process: with several
// runtimes on one Redis, each allows the limit while it is out.
function rateLimiter(opts, deadlineMs) {
  const limit = RollingRateLimiter(opts);
  const local = RollingRateLimiter({interval: opts.interval, maxInInterval: opts.maxInInterval, minDifference: opts.minDifference});
  const ms = deadlineMs != null ? deadlineMs : RATE_LIMIT_DEADLINE_MS;
  // (cb runs outside the promise: a throw in the request path it carries is
  // an exception, never an unhandled rejection: the medium on #443's high
  // round, 5)
  // Every check is counted in memory as well (the reviewer's countinghouse
  // high, #443's lead): a check passes only when every count it has allows
  // it -- Redis's (every process's) and this process's own -- and when Redis
  // doesn't answer, this process's alone decides. So a key at its limit
  // never gets a fresh allowance when Redis drops, and a flapping Redis
  // never lets more than the limit through here. (Several processes on one
  // Redis each count only their own while it is down: N times the limit
  // during an outage, a hosted runtime's residual; release 1 is one process.)
  // The in-memory window is keyed by the key's meterId, never the key
  // (lib/key-fingerprint.js).
  return function(id, cb) {
    // (an id that is already a fingerprint -- the metering providers pass
    // meterId(key) -- is used as it is: one hash per check, not two)
    const own = /^sha256:[0-9a-f]{64}$/.test(String(id)) ? String(id) : meterId(String(id));
    const counted = new Promise((resolve) => local(own, (err, ...rest) => resolve({err, rest})));
    withDeadline(ms, (done) => limit(id, (err, ...rest) => done(err, rest)), () => {
      const e = new Error(`rate-limit check got no answer from Redis in ${ms} ms`);
      e.code = 'RATE_LIMIT_TIMEOUT';
      return e;
    }).then((rest) => counted.then((mine) => {
      // (the stricter of the two: the longer wait; Redis's own answer when
      // this process's count can't be read)
      // (and the fewer actions left of the two: one limited by this
      // process's count never says it has calls left -- the medium)
      const theirs = rest[0];
      const ownWait = mine.err == null ? mine.rest[0] : 0;
      const left = mine.err == null && mine.rest[1] != null && rest[1] != null ? Math.min(Number(rest[1]), Number(mine.rest[1])) : rest[1];
      process.nextTick(() => cb(null, Math.max(Number(theirs) || 0, Number(ownWait) || 0), left, ...rest.slice(2)));
    }), () => counted.then((mine) => {
      // (outside the promise, as on the branch above: a throw in cb stays an
      // exception, never an unhandled rejection -- #443's round 5; the medium)
      process.nextTick(() => cb(mine.err, ...mine.rest));
    }));
  };
}

module.exports = {createClient, rateLimiter, withDeadline, retryDelay, MAX_RETRY_DELAY_MS, RATE_LIMIT_DEADLINE_MS, FIRST_CONNECT_MS};
