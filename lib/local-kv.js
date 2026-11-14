// LocalKv: the --store local client behind a module's ctx.redis (LM1,
// docs/superpowers/specs/2026-11-11-local-mode-design.md section 1; plan
// 2026-11-11-lm1-store-and-identity.md, Task 6). The commands a module may
// name (lib/redis-api.js ALLOWED_COMMANDS) with Redis's answers and error
// texts and node_redis v3's calling convention (test/local-kv/02 runs them
// against a live Redis): strings (SET's NX/XX/GET/KEEPTTL/EX/PX/EXAT/PXAT),
// hashes, lists, sorted sets (ZADD's NX/XX/GT/LT/CH/INCR), PEXPIRE (its
// NX/XX/GT/LT), multi/exec (an arity error aborts with EXECABORT, a queued
// command's own callback is called). Modules see no difference in the API.
//
// The keys live in the local store's map of <storePath>/kv.json
// (lib/store/json-file.js: written under the store lock, merged by key, so
// processes sharing a store keep each other's keys; the last write of a
// key wins). Each command changes its entry in place and marks the key;
// every PERSIST_MS the map is written, expired keys are swept, and the file
// is read again, so another process's keys are seen within that time.
//
// Arguments are taken as node_redis takes them: a trailing undefined with
// no callback after it is the callback slot; strings, numbers, booleans,
// dates and Buffers become strings; one level of arrays is flattened;
// hmset takes an object of fields. Anything else answers node_redis's
// "invalid argument type" error. No command throws: every error reaches its
// callback, so a malformed value or a stored entry of the wrong shape never
// crashes the main thread.
const path = require('path');

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
const PERSIST_MS = 5000;
const TYPES = {string: 'string', hash: 'object', list: 'array', zset: 'object'};

// Redis's arity (the command name counted; negative means at least that
// many), checked when multi() queues a command.
const ARITY = {get: 2, set: -3, mget: -2, del: -2, pexpire: -3, hget: 3, hset: -4, hmset: -4, hmget: -3, hdel: -3,
  hgetall: 2, lpush: -3, rpush: -3, lrange: 4, llen: 2, ltrim: 4, zadd: -4, zrange: -4, zrem: -3};

function replyError(message) {
  const e = new Error(message);
  e.code = message.split(' ')[0];
  return e;
}
const wrongArgs = (name) => replyError(`ERR wrong number of arguments for '${name}' command`);
const notInteger = () => replyError('ERR value is not an integer or out of range');
const syntax = () => replyError('ERR syntax error');

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
function put(obj, key, value) {
  Object.defineProperty(obj, key, {value: value, enumerable: true, writable: true, configurable: true});
}

// Redis's string2ll: an optional minus, no leading zeros, no plus, in the
// signed 64-bit range.
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
function integer(value) {
  const s = String(value);
  if (!/^(0|-?[1-9][0-9]*)$/.test(s)) throw notInteger();
  const n = BigInt(s);
  if (n < INT64_MIN || n > INT64_MAX) throw notInteger();
  return Number(n);
}
// Redis's float parsing: a plain decimal or exponent form, or inf and
// infinity with a sign, no surrounding space, never nan.
function float(value) {
  const s = String(value);
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(s)) throw replyError('ERR value is not a valid float');
  return Number(s);
}
function scoreText(n) {
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  return String(n);
}
// A Redis range [start, stop] over a length, inclusive, negative from the end.
function range(start, stop, length) {
  let a = integer(start);
  let b = integer(stop);
  if (a < 0) a = Math.max(length + a, 0);
  if (b < 0) b = length + b;
  if (b >= length) b = length - 1;
  return (a > b || a >= length) ? null : [a, b];
}

function invalidArgument(name, value) {
  return new Error(`node_redis: The ${name.toUpperCase()} command contains a invalid argument type${
    value === undefined ? ' of "undefined"' : ''}.\nOnly strings, dates and buffers are accepted. Please update your code to use valid argument types.`);
}
// The arguments as strings, as node_redis sends them.
function argsOf(name, args) {
  const out = [];
  const one = (a) => {
    if (typeof(a) === 'string') return out.push(a);
    if (typeof(a) === 'number' || typeof(a) === 'boolean') return out.push(String(a));
    if (a instanceof Date) return out.push(a.toString());
    if (Buffer.isBuffer(a)) return out.push(a.toString());
    throw invalidArgument(name, a);
  };
  args.forEach((a, i) => {
    if (Array.isArray(a)) a.forEach(one);
    else if (name === 'hmset' && i === 1 && a != null && typeof(a) === 'object' && !Buffer.isBuffer(a) && !(a instanceof Date)) {
      for (const k of Object.keys(a)) { one(k); one(a[k]); }
    } else one(a);
  });
  return out;
}

function LocalKv(opts) {
  const o = opts || {};
  this.now = (typeof(o.now) === 'function') ? o.now : Date.now;
  this.file = require('./store/json-file').openJsonFile(path.join(o.storePath, 'kv.json'), {debounceMs: PERSIST_MS});
  this.timer = setInterval(() => { this.sweep(); this.file.flush(); this.reload(); }, PERSIST_MS);
  if (typeof(this.timer.unref) === 'function') this.timer.unref();
}

// A stored entry of the shape this file writes, else nothing (a malformed
// one is dropped: a hand edit, or a writer of another version).
function valid(e) {
  if (e == null || typeof(e) !== 'object' || !own(TYPES, e.t)) return false;
  if (e.exp != null && typeof(e.exp) !== 'number') return false;
  const want = TYPES[e.t];
  if (want === 'array') return Array.isArray(e.v) && e.v.every((x) => typeof(x) === 'string');
  if (want === 'object') return e.v != null && typeof(e.v) === 'object' && !Array.isArray(e.v);
  return typeof(e.v) === want;
}

// The entry for a key, or undefined; an expired or malformed one is removed.
LocalKv.prototype.entry = function(key) {
  const data = this.file.data;
  if (!own(data, key)) return undefined;
  const e = data[key];
  if (!valid(e)) {
    this.file.delete(key);
    try { require('./logger').W(`local store: kv entry ${JSON.stringify(key).slice(0, 80)} was not a valid entry; dropped`); } catch (logErr) { /* bare process */ }
    return undefined;
  }
  if (e.exp != null && e.exp <= this.now()) {
    this.file.delete(key);
    return undefined;
  }
  return e;
};
LocalKv.prototype.typed = function(key, t) {
  const e = this.entry(key);
  if (e != null && e.t !== t) throw replyError(WRONGTYPE);
  return e;
};
LocalKv.prototype.store = function(key, entry) {
  this.file.set(key, entry);
};
LocalKv.prototype.changed = function(key, entry) {
  this.file.set(key, entry);
};
LocalKv.prototype.remove = function(key) {
  this.file.delete(key);
};

// Every key that starts with prefix, deleted, another process's included (the
// file is read again first) -> how many were live (an expired or malformed
// one is dropped, uncounted, as a read would). Written out by the store's
// own scheduled write, never a lock wait here. The main thread's alone, for
// an uninstalled module's namespace (lib/redis-namespace.js purgeNamespace);
// no module command reaches it.
LocalKv.prototype.deletePrefix = function(prefix) {
  this.file.reload();
  let n = 0;
  for (const key of Object.keys(this.file.data)) {
    if (!key.startsWith(prefix)) continue;
    if (this.entry(key) != null) { this.file.delete(key); n += 1; }
  }
  return n;
};

// Expired keys nobody reads, removed (from memory, and kv.json at the next
// write).
LocalKv.prototype.sweep = function() {
  for (const key of Object.keys(this.file.data)) this.entry(key);
};
// The file as it is now (another process's keys), this process's unwritten
// ones over it.
LocalKv.prototype.reload = function() {
  this.file.reload();
};

const COMMANDS = {
  get(a) {
    if (a.length !== 1) throw wrongArgs('get');
    const e = this.typed(a[0], 'string');
    return (e != null) ? e.v : null;
  },
  set(a) {
    if (a.length < 2) throw wrongArgs('set');
    const [key, value, ...opts] = a;
    let nx = false;
    let xx = false;
    let get = false;
    let keepTtl = false;
    let exp = null;
    let expiries = 0;
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i].toUpperCase();
      if (opt === 'NX' && !xx) nx = true;
      else if (opt === 'XX' && !nx) xx = true;
      else if (opt === 'GET') get = true;
      else if (opt === 'KEEPTTL') { keepTtl = true; expiries++; }
      else if (['EX', 'PX', 'EXAT', 'PXAT'].includes(opt) && i + 1 < opts.length) {
        const n = integer(opts[++i]);
        if (n <= 0) throw replyError("ERR invalid expire time in 'set' command");
        exp = (opt === 'EX') ? this.now() + n * 1000 : (opt === 'PX') ? this.now() + n : (opt === 'EXAT') ? n * 1000 : n;
        expiries++;
      } else throw syntax();
    }
    if (expiries > 1) throw syntax();
    const old = this.entry(key);
    if (get && old != null && old.t !== 'string') throw replyError(WRONGTYPE);
    const answer = get ? ((old != null) ? old.v : null) : 'OK';
    if ((nx && old != null) || (xx && old == null)) return get ? answer : null;
    const entry = {t: 'string', v: value};
    if (exp != null) entry.exp = exp;
    else if (keepTtl && old != null && old.exp != null) entry.exp = old.exp;
    if (entry.exp != null && entry.exp <= this.now()) this.remove(key);
    else this.store(key, entry);
    return answer;
  },
  mget(a) {
    if (a.length < 1) throw wrongArgs('mget');
    return a.map((key) => { const e = this.entry(key); return (e != null && e.t === 'string') ? e.v : null; });
  },
  del(a) {
    if (a.length < 1) throw wrongArgs('del');
    let n = 0;
    for (const key of a) if (this.entry(key) != null) { this.remove(key); n++; }
    return n;
  },
  pexpire(a) {
    if (a.length < 2) throw wrongArgs('pexpire');
    const ms = integer(a[1]);
    const flags = new Set();
    for (const f of a.slice(2)) {
      const flag = f.toUpperCase();
      if (!['NX', 'XX', 'GT', 'LT'].includes(flag)) throw replyError(`ERR Unsupported option ${f}`);
      flags.add(flag);
    }
    if (flags.has('NX') && (flags.has('XX') || flags.has('GT') || flags.has('LT'))) {
      throw replyError('ERR NX and XX, GT or LT options at the same time are not compatible');
    }
    if (flags.has('GT') && flags.has('LT')) throw replyError('ERR GT and LT options at the same time are not compatible');
    const e = this.entry(a[0]);
    if (e == null) return 0;
    const at = this.now() + ms;
    const current = (e.exp != null) ? e.exp : Infinity;
    if (flags.has('NX') && e.exp != null) return 0;
    if (flags.has('XX') && e.exp == null) return 0;
    if (flags.has('GT') && !(at > current)) return 0;
    if (flags.has('LT') && !(at < current)) return 0;
    if (ms <= 0) { this.remove(a[0]); return 1; }
    e.exp = at;
    this.changed(a[0], e);
    return 1;
  },
  hget(a) {
    if (a.length !== 2) throw wrongArgs('hget');
    const e = this.typed(a[0], 'hash');
    return (e != null && own(e.v, a[1])) ? e.v[a[1]] : null;
  },
  hset(a) { return hsetLike.call(this, 'hset', a); },
  hmset(a) { hsetLike.call(this, 'hmset', a); return 'OK'; },
  hmget(a) {
    if (a.length < 2) throw wrongArgs('hmget');
    const e = this.typed(a[0], 'hash');
    return a.slice(1).map((f) => (e != null && own(e.v, f)) ? e.v[f] : null);
  },
  hdel(a) {
    if (a.length < 2) throw wrongArgs('hdel');
    const e = this.typed(a[0], 'hash');
    if (e == null) return 0;
    let n = 0;
    for (const f of a.slice(1)) if (own(e.v, f)) { delete e.v[f]; n++; }
    if (Object.keys(e.v).length === 0) this.remove(a[0]);
    else if (n > 0) this.changed(a[0], e);
    return n;
  },
  hgetall(a) {
    if (a.length !== 1) throw wrongArgs('hgetall');
    const e = this.typed(a[0], 'hash');
    if (e == null) return null;
    const out = {};
    for (const f of Object.keys(e.v)) put(out, f, e.v[f]);
    return out;
  },
  lpush(a) { return push.call(this, 'lpush', a, true); },
  rpush(a) { return push.call(this, 'rpush', a, false); },
  lrange(a) {
    if (a.length !== 3) throw wrongArgs('lrange');
    const e = this.typed(a[0], 'list');
    const list = (e != null) ? e.v : [];
    const r = range(a[1], a[2], list.length);
    return (r == null) ? [] : list.slice(r[0], r[1] + 1);
  },
  llen(a) {
    if (a.length !== 1) throw wrongArgs('llen');
    const e = this.typed(a[0], 'list');
    return (e != null) ? e.v.length : 0;
  },
  ltrim(a) {
    if (a.length !== 3) throw wrongArgs('ltrim');
    const e = this.typed(a[0], 'list');
    const list = (e != null) ? e.v : [];
    const r = range(a[1], a[2], list.length);
    if (e == null) return 'OK';
    if (r == null) { this.remove(a[0]); return 'OK'; }
    list.splice(r[1] + 1);
    list.splice(0, r[0]);
    this.changed(a[0], e);
    return 'OK';
  },
  zadd(a) {
    if (a.length < 3) throw wrongArgs('zadd');
    const flags = new Set();
    let i = 1;
    while (i < a.length && ['NX', 'XX', 'GT', 'LT', 'CH', 'INCR'].includes(a[i].toUpperCase())) flags.add(a[i++].toUpperCase());
    const rest = a.slice(i);
    if (rest.length === 0 || rest.length % 2 !== 0) throw syntax();
    if (flags.has('NX') && flags.has('XX')) throw replyError('ERR XX and NX options at the same time are not compatible');
    if ((flags.has('GT') && flags.has('LT')) || ((flags.has('GT') || flags.has('LT')) && flags.has('NX'))) {
      throw replyError('ERR GT, LT, and/or NX options at the same time are not compatible');
    }
    if (flags.has('INCR') && rest.length !== 2) throw replyError('ERR INCR option supports a single increment-element pair');
    const pairs = [];
    for (let j = 0; j < rest.length; j += 2) pairs.push([float(rest[j]), rest[j + 1]]);
    const existing = this.typed(a[0], 'zset');
    const e = existing || {t: 'zset', v: {}};
    let added = 0;
    let changedN = 0;
    let incrResult = null;
    for (const [score, member] of pairs) {
      const has = own(e.v, member);
      if (flags.has('NX') && has) continue;
      if (flags.has('XX') && !has) continue;
      const next = flags.has('INCR') ? (has ? e.v[member] : 0) + score : score;
      if (Number.isNaN(next)) throw replyError('ERR resulting score is not a number (NaN)');
      if (has && flags.has('GT') && !(next > e.v[member])) continue;
      if (has && flags.has('LT') && !(next < e.v[member])) continue;
      if (!has) added++;
      else if (e.v[member] !== next) changedN++;
      put(e.v, member, next);
      incrResult = scoreText(next);
    }
    if (Object.keys(e.v).length > 0 && (added > 0 || changedN > 0 || existing != null)) this.store(a[0], e);
    if (flags.has('INCR')) return incrResult;
    return added + (flags.has('CH') ? changedN : 0);
  },
  zrange(a) {
    if (a.length < 3) throw wrongArgs('zrange');
    if (a.length > 4 || (a.length === 4 && a[3].toUpperCase() !== 'WITHSCORES')) throw syntax();
    const e = this.typed(a[0], 'zset');
    const sorted = ((e != null) ? Object.keys(e.v).map((m) => [m, e.v[m]]) : [])
      .sort((x, y) => ((x[1] < y[1]) ? -1 : (x[1] > y[1]) ? 1 : (x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : 0))));
    const r = range(a[1], a[2], sorted.length);
    if (r == null) return [];
    const picked = sorted.slice(r[0], r[1] + 1);
    return (a.length === 4) ? picked.flatMap(([m, s]) => [m, scoreText(s)]) : picked.map(([m]) => m);
  },
  zrem(a) {
    if (a.length < 2) throw wrongArgs('zrem');
    const e = this.typed(a[0], 'zset');
    if (e == null) return 0;
    let n = 0;
    for (const m of a.slice(1)) if (own(e.v, m)) { delete e.v[m]; n++; }
    if (Object.keys(e.v).length === 0) this.remove(a[0]);
    else if (n > 0) this.changed(a[0], e);
    return n;
  },
  exec() {
    throw replyError('ERR EXEC without MULTI');
  }
};

function hsetLike(name, a) {
  if (a.length < 3 || (a.length - 1) % 2 !== 0) throw wrongArgs(name);
  const existing = this.typed(a[0], 'hash');
  const e = existing || {t: 'hash', v: {}};
  let added = 0;
  for (let i = 1; i < a.length; i += 2) {
    if (!own(e.v, a[i])) added++;
    put(e.v, a[i], a[i + 1]);
  }
  this.store(a[0], e);
  return added;
}

function push(name, a, left) {
  if (a.length < 2) throw wrongArgs(name);
  const existing = this.typed(a[0], 'list');
  const e = existing || {t: 'list', v: []};
  for (const value of a.slice(1)) {
    if (left) e.v.unshift(value);
    else e.v.push(value);
  }
  this.store(a[0], e);
  return e.v.length;
}

// A command's reply, or the error it answers (never a throw).
LocalKv.prototype.answer = function(name, args) {
  try {
    return {reply: COMMANDS[name].call(this, argsOf(name, args))};
  } catch (e) {
    return {err: (e instanceof Error) ? e : new Error(String(e))};
  }
};

// node_redis's convention: a trailing callback; a trailing undefined with
// no callback after it is the empty callback slot.
function split(args) {
  const list = args.slice();
  let callback;
  if (typeof(list[list.length - 1]) === 'function') callback = list.pop();
  else if (list.length > 0 && list[list.length - 1] === undefined) list.pop();
  return {list, callback};
}

Object.keys(COMMANDS).forEach((name) => {
  LocalKv.prototype[name] = function(...args) {
    const {list, callback} = split(args);
    const {reply, err} = this.answer(name, list);
    if (typeof(callback) === 'function') process.nextTick(callback, (err != null) ? err : null, (err != null) ? undefined : reply);
    return true;
  };
});

// multi([commands]): the commands queued (each [name, ...args, callback?])
// and run in order by exec(callback(err, replies)), a command's error in
// its place among the replies and each queued command's own callback
// called, as node_redis gives them. An arity error while queueing aborts
// the whole transaction (EXECABORT), as Redis does. (One process: nothing
// runs between them.)
LocalKv.prototype.multi = function(commands) {
  const kv = this;
  const queued = [];
  let aborted = false;
  const queue = (name, args) => {
    const {list, callback} = split(args);
    const arity = ARITY[name];
    const n = list.reduce((sum, a) => sum + (Array.isArray(a) ? a.length : 1), 1);
    if ((arity > 0) ? n !== arity : n < -arity) aborted = true;
    queued.push({name, list, callback});
  };
  const batch = {
    exec(callback) {
      let replies = null;
      let err = null;
      if (aborted) {
        err = replyError('EXECABORT Transaction discarded because of previous errors.');
        queued.forEach((q) => { if (q.callback) process.nextTick(q.callback, err); });
      } else {
        replies = queued.map((q) => {
          const r = kv.answer(q.name, q.list);
          if (q.callback) process.nextTick(q.callback, (r.err != null) ? r.err : null, r.reply);
          return (r.err != null) ? r.err : r.reply;
        });
      }
      if (typeof(callback) === 'function') process.nextTick(callback, err, (err != null) ? undefined : replies);
      return true;
    }
  };
  Object.keys(COMMANDS).filter((n) => n !== 'exec').forEach((name) => {
    batch[name] = (...args) => { queue(name, args); return batch; };
  });
  if (Array.isArray(commands)) {
    for (const c of commands) {
      if (Array.isArray(c) && own(COMMANDS, String(c[0]).toLowerCase())) queue(String(c[0]).toLowerCase(), c.slice(1));
    }
  }
  return batch;
};

// Expired keys swept, then written now (shutdown, tests).
LocalKv.prototype.close = function() {
  clearInterval(this.timer);
  this.sweep();
  this.file.close();
};

module.exports = LocalKv;
