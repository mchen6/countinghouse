'use strict';
// A module's question asked from inside a 2026-07-28 task (MCP completeness
// M22, spec sections 8 and 9; ext-tasks 2026-07-28). The handler waits as it
// does on a call (M13): the pass that asks ends, and it runs again from the
// top once the question has its answer. A call's client carries its state
// back in a requestState; a task's state is held here, on the server, and
// never travels: the task-ask record.
//
// The record is the store's kv (Redis db 5, or the local kv), under
// task-ask:<taskId>, beside M15's tombstones (lib/task-tombstones.js): a key
// outside every module's namespace (lib/redis-namespace.js puts a module's
// keys under m: or ms:), so no module's ctx.redis reaches it. The main
// thread alone reads and writes it; no worker sees it.
//
//   {owner, session, pending, answers, unavailable, rounds, callRounds,
//    seq, askedAt, expiresAt}
//
//   owner       the task's owner, its job owner's opaque id (as the
//               tombstone has it)
//   session     sessionKey of the job's session (a sha256), never the id
//   pending     the question waiting, or null once it is answered and the
//               run is starting again: {reqKey, qKey, name, text, schema,
//               pointer, asker, module, round}. reqKey is its inputRequests
//               key (q<seq>, unique over the task's life, as ext-tasks
//               requires); qKey the question's own (module-questions keyOf)
//   answers     qKey -> the validated content, or null for a decline
//   unavailable the questions three rounds left unanswered
//   rounds      qKey -> the rounds that question has had with no answer
//   callRounds  the task's rounds in all, every question's together
//
// The task reads input_required while pending is set; tasks/update's answer
// for its reqKey is taken once (take: a compare-and-set), checked against
// the question's schema by the asker's validators, and the run is started
// again under the same taskId. A question waits at most WAIT_MS: past that
// the task reads failed, ASK_EXPIRED, and nothing runs again.
const {CountinghouseError} = require('./countinghouse-error');
const moduleAsk = require('./module-ask');
const {sessionKey} = require('./task-tombstones');

const PREFIX = 'task-ask:';
// the tasks waiting on a question, per owner and in all: sorted sets of
// taskIds scored by when their wait ends
const OWNER_PREFIX = 'task-ask-owner:';
const ALL = 'task-ask-all';
const WAIT_MS = 60 * 60 * 1000;
const MAX_PER_OWNER = 64;
const MAX_TOTAL = 10000;
// the record outlives its wait by this much, so a reader after the wait
// learns it expired rather than finding nothing
const KEPT_PAST_WAIT_MS = 60 * 60 * 1000;
const STATUS_MESSAGE = 'waiting for an answer';
// an answer's content, and every answer a task holds, together (as M13
// bounds a requestState's: lib/request-state.js MAX_ANSWERS_BYTES)
const MAX_ANSWERS_BYTES = require('./request-state').MAX_ANSWERS_BYTES;

// (tests: configure merges what it is given, and leaves the rest as it is)
const config = {waitMs: WAIT_MS, maxPerOwner: MAX_PER_OWNER, maxTotal: MAX_TOTAL, now: () => Date.now(),
  kv: () => require('./store').getStore().kv};
function configure(given = {}) {
  Object.assign(config, given);
}

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const keyOf = (taskId) => `${PREFIX}${taskId}`;

const call = (op, ...args) => new Promise((resolve, reject) => {
  const kv = config.kv();
  kv[op](...args, (err, value) => (err != null ? reject(err) : resolve(value)));
});

// A record as stored, made whole: anything missing is empty (Redis's cjson
// writes an empty list back as an object)
function normal(r) {
  if (!isObject(r)) return null;
  return {owner: typeof(r.owner) === 'string' ? r.owner : null, session: typeof(r.session) === 'string' ? r.session : null,
    pending: isObject(r.pending) ? r.pending : null, answers: isObject(r.answers) ? r.answers : {},
    unavailable: Array.isArray(r.unavailable) ? r.unavailable.filter((k) => typeof(k) === 'string') : [],
    rounds: isObject(r.rounds) ? r.rounds : {}, callRounds: Number.isInteger(r.callRounds) ? r.callRounds : 0,
    seq: Number.isInteger(r.seq) ? r.seq : 0, askedAt: Number(r.askedAt) || 0, expiresAt: Number(r.expiresAt) || 0};
}

function get(taskId) {
  return call('get', keyOf(taskId)).then((text) => {
    if (typeof(text) !== 'string') return null;
    try { return normal(JSON.parse(text)); } catch (e) { return null; }
  });
}

// written for as long as its wait, and KEPT_PAST_WAIT_MS more. replace: only
// over a record that is still there (a cancel that removed it meanwhile
// wins: nothing is written back)
function write(taskId, record, {replace = false} = {}) {
  const ms = Math.max(1, record.expiresAt - config.now()) + KEPT_PAST_WAIT_MS;
  const args = [keyOf(taskId), JSON.stringify(record), 'PX', String(ms)];
  if (replace) args.push('XX');
  return call('set', ...args).then((ok) => ok === 'OK');
}

// One change at a time per task, in this process: the local store's
// compare-and-set (its kv is this process's), and an order for this
// process's own updates on Redis, where take's script is what makes one
// answer win across processes.
const chains = new Map();
function serial(taskId, fn) {
  const before = chains.get(taskId) || Promise.resolve();
  const next = before.then(fn, fn);
  const settled = next.then(() => {}, () => {});
  chains.set(taskId, settled);
  settled.then(() => { if (chains.get(taskId) === settled) chains.delete(taskId); });
  return next;
}

// Takes the waiting question whose inputRequests key is reqKey, once: the
// record is written back with no question waiting, and the record as it
// was is the answer. null: no such question waits (never issued, answered,
// stale, or the record is gone).
const TAKE_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if not v then return false end
local r = cjson.decode(v)
if type(r.pending) ~= 'table' or r.pending.reqKey ~= ARGV[1] then return false end
r.pending = nil
local ttl = redis.call('PTTL', KEYS[1])
if ttl and ttl > 0 then redis.call('SET', KEYS[1], cjson.encode(r), 'PX', ttl) else redis.call('SET', KEYS[1], cjson.encode(r)) end
return v`;
function takeNow(taskId, reqKey) {
  const kv = config.kv();
  if (typeof(kv.eval) === 'function') {
    return new Promise((resolve, reject) => kv.eval(TAKE_SCRIPT, 1, keyOf(taskId), reqKey, (err, v) => {
      if (err != null) return reject(err);
      if (typeof(v) !== 'string') return resolve(null);
      try { return resolve(normal(JSON.parse(v))); } catch (e) { return resolve(null); }
    }));
  }
  // the local store: this process's kv, read and written under serial
  return get(taskId).then((r) => {
    if (r == null || r.pending == null || r.pending.reqKey !== reqKey) return null;
    return write(taskId, Object.assign({}, r, {pending: null}), {replace: true}).then((ok) => (ok ? r : null));
  });
}
// (answer takes inside its own serial step, with takeNow)
const take = (taskId, reqKey) => serial(taskId, () => takeNow(taskId, reqKey));

// The tasks waiting on a question, per owner and in all: sorted sets of
// taskIds scored by when their wait ends. A slot is reserved in one step
// (the review of #374, L3): on Redis one script (the ended dropped, both
// counted, both added), on the local store under one in-process serial; a
// count is ZCOUNT from now, never a read of the whole set.
const RESERVE_SCRIPT = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ARGV[3]) then
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) or redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return 0 end
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
return 1`;
const ROOM_SCRIPT = `
local now = ARGV[1]
if redis.call('ZCOUNT', KEYS[1], '(' .. now, '+inf') >= tonumber(ARGV[2]) or redis.call('ZCOUNT', KEYS[2], '(' .. now, '+inf') >= tonumber(ARGV[3]) then return 0 end
return 1`;
const evalOf = () => { const kv = config.kv(); return typeof(kv.eval) === 'function' ? kv : null; };
// the local store: a set's live members, the ended dropped on the way
function liveOf(set) {
  return call('zrange', set, '0', '-1', 'WITHSCORES').then((flat) => {
    const now = config.now();
    const live = new Set();
    const gone = [];
    for (let i = 0; i + 1 < (flat || []).length; i += 2) {
      if (Number(flat[i + 1]) > now) live.add(flat[i]); else gone.push(flat[i]);
    }
    return (gone.length > 0 ? call('zrem', set, ...gone).catch(() => {}) : Promise.resolve()).then(() => live);
  });
}
const CAPS = '(the caps)';
// whether one more task of this owner's may wait on a question now: at most
// maxPerOwner of an owner's at once, and maxTotal in all (a look ahead, for
// a run's start; reserve is what holds a slot)
function roomFor(owner) {
  const kv = evalOf();
  if (kv != null) {
    return new Promise((resolve) => kv.eval(ROOM_SCRIPT, 2, `${OWNER_PREFIX}${owner}`, ALL, String(config.now()), String(config.maxPerOwner), String(config.maxTotal),
      (err, v) => resolve(err == null && Number(v) === 1)));
  }
  return Promise.all([liveOf(`${OWNER_PREFIX}${owner}`), liveOf(ALL)])
    .then(([mine, all]) => mine.size < config.maxPerOwner && all.size < config.maxTotal, () => false);
}
// -> Promise of whether a slot is held for taskId until `until` (one it
// holds already is kept, its time moved)
function reserve(taskId, owner, until) {
  const kv = evalOf();
  if (kv != null) {
    return new Promise((resolve) => kv.eval(RESERVE_SCRIPT, 2, `${OWNER_PREFIX}${owner}`, ALL, String(config.now()), String(until), taskId,
      String(config.maxPerOwner), String(config.maxTotal), (err, v) => resolve(err == null && Number(v) === 1)));
  }
  return serial(CAPS, () => Promise.all([liveOf(`${OWNER_PREFIX}${owner}`), liveOf(ALL)]).then(([mine, all]) => {
    if (!mine.has(taskId) && (mine.size >= config.maxPerOwner || all.size >= config.maxTotal)) return false;
    return Promise.all([call('zadd', `${OWNER_PREFIX}${owner}`, String(until), taskId), call('zadd', ALL, String(until), taskId)]).then(() => true);
  })).catch(() => false);
}
const unmarkWaiting = (taskId, owner) => Promise.all([owner != null ? call('zrem', `${OWNER_PREFIX}${owner}`, taskId) : null, call('zrem', ALL, taskId)]).catch(() => {});

// The ask state a run of a task starts with (the call token's, as a call's
// is: lib/module-ask.js), or what the run is to do instead.
//   asks       whether the request that made the task declared form
//              elicitation (job.data.asks), with module questions on
//   asking     whether its last pass ended on a question (job.data.asking)
//   owner      the task's owner (its opaque id)
//   shownAs    the listed module's name, which every dialog carries
// -> Promise of {state} (null: no one to ask, ctx.ask is ASK_UNAVAILABLE),
// or {skip: true}: a run started again whose question was not answered
// (its record gone: cancelled or expired, or still waiting): it runs nothing.
// A record that can't be read (the store failed) rejects: never a fresh
// record, whose counts would start over (#487's high, round 1).
//   owner      the task's owner: with no room for one more of its waiting
//              tasks, a task with no record yet has no one to ask (as on
//              master; #487's high, round 1, cut the wait for room)
//   rerun      a pass of a run started again within itself (a question no
//              form could be shown for): a record missing then is no skip
//              -- the pass runs with a fresh state, as if the task had not
//              asked (ruled on F2-2's medium)
function forRun(taskId, {asks, asking, owner, shownAs, rerun = false}) {
  return get(taskId).then((r) => {
    if (asking === true && ((r == null && rerun !== true) || (r != null && (r.pending != null || r.expiresAt <= config.now())))) return {skip: true};
    if (asks !== true) return {state: null};
    const fill = (state) => {
      if (r == null) return {state};
      for (const k of Object.keys(r.answers)) {
        const v = r.answers[k];
        if (v === null || isObject(v)) state.answers.set(k, v);
      }
      for (const k of r.unavailable) state.unavailable.add(k);
      for (const k of Object.keys(r.rounds)) if (Number.isInteger(r.rounds[k])) state.rounds.set(k, r.rounds[k]);
      state.callRounds = r.callRounds;
      return {state};
    };
    // a task that may ask, when there is no room for one more waiting: no
    // one to ask, at once (ASK_UNAVAILABLE), and nothing stored -- as on
    // master (#487's high, round 1, cut the wait for room)
    const make = () => moduleAsk.newState({askable: true, shownAs});
    if (r != null) return fill(make());
    return roomFor(owner).then((room) => (room ? fill(make()) : {state: null}));
  });
}

// The pass ended on its question (state.pending, the main thread's own
// record of it): the record is written and the task reads input_required.
//   ofAsker    who asked, as the main thread holds it now (module-ask
//              ofDevice), for the form
//   session    the job's session (its raw id: only its hash is kept)
// -> Promise of {asked: {round, askedBy}} (the record is written), or
// {rerun: true}: no form can be shown (none to make, or past the task's
// rounds), or there is no room for one more waiting task: the question is
// unavailable -- a round of the task's -- and the run starts again at
// once, where its ctx.ask is ASK_UNAVAILABLE. A record that can't be read
// rejects (the pass fails), never a fresh record.
//   cancelled  -> Promise of whether the task was cancelled meanwhile (its
//              tombstone): its record then goes, and with it its slot (the
//              review of #374, L2), and the answer is {cancelled: true}
function asked(taskId, state, {owner, session = null, ofAsker, cancelled = null}) {
  return serial(taskId, () => get(taskId).then((before) => {
    const pending = moduleAsk.isState(state) ? state.pending : null;
    const recordOf = () => {
      const r = before != null ? before : normal({owner, session: sessionKey(session)});
      r.pending = null;
      return r;
    };
    // The form itself can't be shown (its asker gone, a form no answer
    // could fill, a state that is no module-ask state), or there is no room
    // for one more waiting task (64 of an owner's, 10,000 in all): the
    // question is unavailable, and it is a round of the task's, as an asked
    // one is.
    // Past its rounds, its ctx.ask is ASK_UNAVAILABLE at once (module-ask),
    // so a handler that asks with another value each pass stops (F2-2: it
    // re-ran for ever, unbilled). The run starts again at once.
    const unavailable = (r = recordOf()) => {
      if (pending != null && !r.unavailable.includes(pending.key)) r.unavailable.push(pending.key);
      r.callRounds = (Number.isInteger(r.callRounds) ? r.callRounds : 0) + 1;
      r.askedAt = config.now();
      r.expiresAt = r.askedAt + config.waitMs;
      return write(taskId, r).then(() => ({rerun: true}));
    };
    if (pending == null) return unavailable();
    const now0 = config.now();
    return moduleAsk.formFor(state, {ofAsker}).then((form) => reserve(taskId, owner, now0 + config.waitMs).then((room) => {
      // (no room: unavailable at once, as on master -- #487's high, round 1,
      // cut the wait for room, a later row)
      if (!room) return unavailable();
      const now = now0;
      const answers = {};
      const unavail = [];
      for (const k of Object.keys(form.answers)) {
        if (form.answers[k] === false) unavail.push(k); else answers[k] = form.answers[k];
      }
      const rounds = {};
      for (const [k, v] of state.rounds) rounds[k] = v;
      const seq = (before != null ? before.seq : 0) + 1;
      const record = {owner, session: sessionKey(session),
        pending: {reqKey: `q${seq}`, qKey: pending.key, name: pending.question, text: pending.text, schema: form.schema, pointer: pending.schema,
          asker: pending.asker, module: pending.module, round: form.round},
        answers, unavailable: unavail, rounds, callRounds: form.callRound, seq, askedAt: now, expiresAt: now + config.waitMs};
      return write(taskId, record).then(() => ({
        asked: {round: form.callRound, askedBy: {module: pending.module, action: pending.asker.actionName, question: pending.question}}}));
    }), () => unavailable());
  })).then((r) => {
    if (typeof(cancelled) !== 'function') return r;
    return Promise.resolve().then(cancelled).then((gone) => (gone === true ? remove(taskId).then(() => ({cancelled: true})) : r), () => r);
  });
}

// Whether a reader in this session may see the record: the job's session
// by the scope rule, compared by its hash (as findModernTask judges a
// tombstone's)
function seenBy(record, session) {
  const scope = require('./session-scope');
  return scope.sees(scope.of(sessionKey(session)), record.session == null ? null : record.session);
}

// What tasks/get shows of a task whose last pass asked: {status:
// 'input_required', statusMessage, inputRequests} while its question waits;
// {status: 'working'} once it is answered and the run starts again; or
// {expired: true} once its wait has ended (or its record is gone, which
// only the wait's end leaves: a cancel removes the job with it).
function view(taskId, session) {
  return get(taskId).catch(() => null).then((r) => {
    if (r == null || r.expiresAt <= config.now()) return {expired: true};
    if (!seenBy(r, session) || r.pending == null) return {status: 'working'};
    const p = r.pending;
    return {status: 'input_required', statusMessage: STATUS_MESSAGE,
      // the form as it leaves, cleaned (lib/client-text.js schema); the
      // record keeps it as declared, which an answer is checked against
      inputRequests: {[p.reqKey]: {method: 'elicitation/create', params: {mode: 'form', message: p.text, requestedSchema: require('./client-text').schema(p.schema).schema}}}};
  });
}

const fits = (answers) => {
  try { return Buffer.byteLength(JSON.stringify(answers), 'utf8') <= MAX_ANSWERS_BYTES; } catch (e) { return false; }
};

// tasks/update's inputResponses for a task (found by findModernTask: the
// caller's own, in its session). Only the waiting question's key is read;
// every other key is ignored (ext-tasks). -> Promise of 'rerun' (answered,
// declined, or three rounds with no answer: the run starts again),
// 'asked' (content its schema refuses: the same question again under a new
// key), or 'ignored' (nothing waits on any key given).
//   ofAsker    who asked, as the main thread holds it now: gone, or no
//              longer declaring the question, and an accept is no answer
//   held       whether the task's job is held on its question now (its
//              asking pass completed): an answer before that is ignored and
//              the question still waits, since nothing could run again yet
//              (the review of #374, L1)
function answer(taskId, responses, {session = null, ofAsker, held = true} = {}) {
  if (!isObject(responses) || held !== true) return Promise.resolve('ignored');
  return serial(taskId, () => get(taskId).catch(() => null).then((seen) => {
    if (seen == null || seen.pending == null || seen.expiresAt <= config.now() || !seenBy(seen, session)) return 'ignored';
    const reqKey = seen.pending.reqKey;
    if (!own(responses, reqKey) || !isObject(responses[reqKey])) return 'ignored';
    const response = responses[reqKey];
    return takeNow(taskId, reqKey).then((r) => {
      if (r == null) return 'ignored';
      const p = r.pending;
      // the checked answer: an object, null for a decline, or undefined for none
      const checked = () => {
        if (response.action === 'decline' || response.action === 'cancel') return Promise.resolve(null);
        if (response.action !== 'accept' || !isObject(response.content)) return Promise.resolve(undefined);
        let content = null;
        try {
          const text = JSON.stringify(response.content);
          if (Buffer.byteLength(text, 'utf8') <= MAX_ANSWERS_BYTES) content = JSON.parse(text);
        } catch (e) { content = null; }
        if (content == null) return Promise.resolve(undefined);
        let of = null;
        try { of = typeof(ofAsker) === 'function' ? ofAsker(p.asker) : null; } catch (e) { of = null; }
        const question = isObject(of) && typeof(of.declared) === 'function' ? of.declared(p.name) : null;
        if (question == null || typeof(of.form) !== 'function') return Promise.resolve(undefined);
        return Promise.resolve().then(() => of.form(question.schema, content)).then((c) => (isObject(c) && c.valid === true ? content : undefined), () => undefined);
      };
      return checked().then((got) => {
        const next = Object.assign({}, r, {pending: null});
        const answers = Object.assign({}, r.answers);
        if (got !== undefined) answers[p.qKey] = got;
        if (got !== undefined && fits(answers)) {
          next.answers = answers;
          return write(taskId, next, {replace: true}).then((ok) => (ok ? unmarkWaiting(taskId, r.owner).then(() => 'rerun') : 'ignored'));
        }
        // none: asked again a round on, and after the third (or past the
        // task's rounds) no more: the run starts again, its ctx.ask
        // ASK_UNAVAILABLE
        if (p.round >= moduleAsk.MAX_ROUNDS || r.callRounds + 1 > moduleAsk.MAX_CALL_ROUNDS) {
          next.unavailable = r.unavailable.includes(p.qKey) ? r.unavailable : r.unavailable.concat([p.qKey]);
          const rounds = Object.assign({}, r.rounds);
          delete rounds[p.qKey];
          next.rounds = rounds;
          return write(taskId, next, {replace: true}).then((ok) => (ok ? unmarkWaiting(taskId, r.owner).then(() => 'rerun') : 'ignored'));
        }
        const seq = r.seq + 1;
        next.seq = seq;
        next.callRounds = r.callRounds + 1;
        next.rounds = Object.assign({}, r.rounds, {[p.qKey]: p.round});
        next.pending = Object.assign({}, p, {reqKey: `q${seq}`, round: p.round + 1});
        return write(taskId, next, {replace: true}).then((ok) => (ok ? 'asked' : 'ignored'));
      });
    });
  }));
}

// The task is done with its question: cancelled, or its run ended without
// asking. Its record goes, and it no longer counts as waiting.
function remove(taskId) {
  return serial(taskId, () => get(taskId).catch(() => null).then((r) => call('del', keyOf(taskId)).catch(() => {})
    .then(() => unmarkWaiting(taskId, r != null ? r.owner : null))));
}

// the kv's keys of a task, for a test that a module's ctx.redis never reaches them
const keysOf = (taskId, owner) => [keyOf(taskId), `${OWNER_PREFIX}${owner}`, ALL];

module.exports = {configure, get, take, forRun, asked, view, answer, remove, keysOf, PREFIX, WAIT_MS, KEPT_PAST_WAIT_MS, MAX_PER_OWNER, MAX_TOTAL, MAX_ANSWERS_BYTES, STATUS_MESSAGE,
  ASK_EXPIRED: () => new CountinghouseError('ASK_EXPIRED')};
