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

const MAX_RETRY_DELAY_MS = 1000;
const RATE_LIMIT_DEADLINE_MS = 500;
const FIRST_CONNECT_MS = 2000;

function retryDelay(attempt) {
  return Math.min(100 * attempt, MAX_RETRY_DELAY_MS);
}

// A promise of start(done)'s answer, or of onTimeout()'s error once ms have
// passed with none: exactly one, the other dropped. start may throw: that
// is its answer.
function withDeadline(ms, start, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(onTimeout());
    }, ms);
    if (typeof(timer.unref) === 'function') timer.unref();
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err != null) reject(err); else resolve(value);
    };
    try { start(done); } catch (e) { done(e); }
  });
}

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
  const timer = setTimeout(queueOff, firstConnectMs != null ? firstConnectMs : FIRST_CONNECT_MS);
  if (typeof(timer.unref) === 'function') timer.unref();
  client.once('ready', queueOff);
  if (commandDeadlineMs > 0) {
    // every command node_redis sends with a callback goes through here
    // (index.js internal_send_command): its callback answers once, with the
    // reply or REDIS_COMMAND_TIMEOUT
    const send = client.internal_send_command;
    client.internal_send_command = function(command) {
      if (command != null && typeof(command.callback) === 'function') {
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
// callback is called exactly once, with an error (code RATE_LIMIT_TIMEOUT)
// if Redis has not answered in time. Every caller already fails open on an
// error.
function rateLimiter(opts, deadlineMs) {
  const limit = RollingRateLimiter(opts);
  const ms = deadlineMs != null ? deadlineMs : RATE_LIMIT_DEADLINE_MS;
  return function(id, cb) {
    withDeadline(ms, (done) => limit(id, (err, ...rest) => done(err, rest)), () => {
      const e = new Error(`rate-limit check got no answer from Redis in ${ms} ms`);
      e.code = 'RATE_LIMIT_TIMEOUT';
      return e;
    }).then((rest) => cb(null, ...rest), (err) => cb(err));
  };
}

module.exports = {createClient, rateLimiter, withDeadline, retryDelay, MAX_RETRY_DELAY_MS, RATE_LIMIT_DEADLINE_MS, FIRST_CONNECT_MS};
