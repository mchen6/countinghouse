// LocalKv: the --store local client behind a module's ctx.redis (LM1,
// docs/superpowers/specs/2026-11-11-local-mode-design.md section 1; plan
// 2026-11-11-lm1-store-and-identity.md, Task 6). The commands a module may
// name (lib/redis-api.js ALLOWED_COMMANDS) over an in-memory map, with
// Redis's answers and error texts (test/local-kv/02-differential.js runs
// them against a live Redis), in node_redis v3's callback style: strings,
// hashes, lists and sorted sets, pexpire's expiry, multi/exec. Modules see
// no difference in the API.
//
// The map persists in <storePath>/kv.json (lib/store/json-file.js: the
// store lock, merged by key, so processes sharing a store keep each
// other's keys; the last write of a key wins), every few seconds and at
// exit. Expiry is checked when a key is read and swept before a write.
const path = require('path');

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
const PERSIST_MS = 5000;

function replyError(message) {
  const e = new Error(message);
  e.code = message.split(' ')[0];
  return e;
}
const wrongArgs = (name) => replyError(`ERR wrong number of arguments for '${name}' command`);
const notInteger = () => replyError('ERR value is not an integer or out of range');

function integer(value) {
  const s = String(value);
  if (!/^-?\d+$/.test(s)) throw notInteger();
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw notInteger();
  return n;
}
function float(value) {
  const s = String(value).toLowerCase();
  if (s === 'inf' || s === '+inf') return Infinity;
  if (s === '-inf') return -Infinity;
  const n = Number(s);
  if (s.trim() === '' || Number.isNaN(n)) throw replyError('ERR value is not a valid float');
  return n;
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

// node_redis flattens one level of array arguments, and takes an object for
// hmset/hset's field-value pairs.
function flatten(name, args) {
  const out = [];
  for (const a of args) {
    if (Array.isArray(a)) out.push(...a);
    else if ((name === 'hmset' || name === 'hset') && a != null && typeof(a) === 'object') {
      for (const [k, v] of Object.entries(a)) out.push(k, v);
    } else out.push(a);
  }
  return out.map((a) => (a == null ? '' : String(a)));
}

function LocalKv(opts) {
  const o = opts || {};
  this.now = (typeof(o.now) === 'function') ? o.now : Date.now;
  this.file = require('./store/json-file').openJsonFile(path.join(o.storePath, 'kv.json'), {debounceMs: PERSIST_MS});
  this.map = new Map();
  for (const [key, entry] of Object.entries(this.file.data)) {
    if (entry != null && typeof(entry) === 'object' && !(entry.exp != null && entry.exp <= this.now())) this.map.set(key, entry);
  }
}

// The entry for a key, or undefined (expired ones are removed).
LocalKv.prototype.entry = function(key) {
  const e = this.map.get(key);
  if (e == null) return undefined;
  if (e.exp != null && e.exp <= this.now()) {
    this.remove(key);
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
  this.map.set(key, entry);
  this.file.set(key, entry);
};
LocalKv.prototype.remove = function(key) {
  this.map.delete(key);
  this.file.delete(key);
};
LocalKv.prototype.touch = function(key, entry) {
  this.store(key, entry);
};

// Each command: (args as strings) -> reply, throwing a reply error.
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
    let exp = null;
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i].toUpperCase();
      if (opt === 'NX') nx = true;
      else if (opt === 'XX') xx = true;
      else if ((opt === 'EX' || opt === 'PX') && i + 1 < opts.length) {
        const n = integer(opts[++i]);
        if (n <= 0) throw replyError("ERR invalid expire time in 'set' command");
        exp = this.now() + (opt === 'EX' ? n * 1000 : n);
      } else throw replyError('ERR syntax error');
    }
    if (nx && xx) throw replyError('ERR syntax error');
    const exists = this.entry(key) != null;
    if ((nx && exists) || (xx && !exists)) return null;
    this.store(key, (exp != null) ? {t: 'string', v: value, exp: exp} : {t: 'string', v: value});
    return 'OK';
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
    if (a.length !== 2) throw wrongArgs('pexpire');
    const ms = integer(a[1]);
    const e = this.entry(a[0]);
    if (e == null) return 0;
    if (ms <= 0) { this.remove(a[0]); return 1; }
    this.touch(a[0], Object.assign({}, e, {exp: this.now() + ms}));
    return 1;
  },
  hget(a) {
    if (a.length !== 2) throw wrongArgs('hget');
    const e = this.typed(a[0], 'hash');
    return (e != null && Object.prototype.hasOwnProperty.call(e.v, a[1])) ? e.v[a[1]] : null;
  },
  hset(a) { return hsetLike.call(this, 'hset', a); },
  hmset(a) { hsetLike.call(this, 'hmset', a); return 'OK'; },
  hmget(a) {
    if (a.length < 2) throw wrongArgs('hmget');
    const e = this.typed(a[0], 'hash');
    return a.slice(1).map((f) => (e != null && Object.prototype.hasOwnProperty.call(e.v, f)) ? e.v[f] : null);
  },
  hdel(a) {
    if (a.length < 2) throw wrongArgs('hdel');
    const e = this.typed(a[0], 'hash');
    if (e == null) return 0;
    const v = Object.assign({}, e.v);
    let n = 0;
    for (const f of a.slice(1)) if (Object.prototype.hasOwnProperty.call(v, f)) { delete v[f]; n++; }
    if (Object.keys(v).length === 0) this.remove(a[0]);
    else this.touch(a[0], Object.assign({}, e, {v: v}));
    return n;
  },
  hgetall(a) {
    if (a.length !== 1) throw wrongArgs('hgetall');
    const e = this.typed(a[0], 'hash');
    return (e != null) ? Object.assign({}, e.v) : null;
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
    if (r == null) this.remove(a[0]);
    else this.touch(a[0], Object.assign({}, e, {v: list.slice(r[0], r[1] + 1)}));
    return 'OK';
  },
  zadd(a) {
    if (a.length < 3 || (a.length - 1) % 2 !== 0) throw (a.length < 3) ? wrongArgs('zadd') : replyError('ERR syntax error');
    const pairs = [];
    for (let i = 1; i < a.length; i += 2) pairs.push([float(a[i]), a[i + 1]]);
    const e = this.typed(a[0], 'zset');
    const members = new Map((e != null) ? e.v : []);
    let added = 0;
    for (const [score, member] of pairs) {
      if (!members.has(member)) added++;
      members.set(member, score);
    }
    this.store(a[0], Object.assign({}, e || {t: 'zset'}, {t: 'zset', v: Array.from(members.entries())}));
    return added;
  },
  zrange(a) {
    if (a.length < 3) throw wrongArgs('zrange');
    if (a.length > 4 || (a.length === 4 && a[3].toUpperCase() !== 'WITHSCORES')) throw replyError('ERR syntax error');
    const e = this.typed(a[0], 'zset');
    const sorted = ((e != null) ? e.v.slice() : []).sort((x, y) => (x[1] - y[1]) || (x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : 0)));
    const r = range(a[1], a[2], sorted.length);
    if (r == null) return [];
    const picked = sorted.slice(r[0], r[1] + 1);
    return (a.length === 4) ? picked.flatMap(([m, s]) => [m, scoreText(s)]) : picked.map(([m]) => m);
  },
  zrem(a) {
    if (a.length < 2) throw wrongArgs('zrem');
    const e = this.typed(a[0], 'zset');
    if (e == null) return 0;
    const members = new Map(e.v);
    let n = 0;
    for (const m of a.slice(1)) if (members.delete(m)) n++;
    if (members.size === 0) this.remove(a[0]);
    else this.touch(a[0], Object.assign({}, e, {v: Array.from(members.entries())}));
    return n;
  },
  exec() {
    throw replyError('ERR EXEC without MULTI');
  }
};

function hsetLike(name, a) {
  if (a.length < 3 || (a.length - 1) % 2 !== 0) throw wrongArgs(name);
  const e = this.typed(a[0], 'hash');
  const v = Object.assign({}, (e != null) ? e.v : {});
  let added = 0;
  for (let i = 1; i < a.length; i += 2) {
    if (!Object.prototype.hasOwnProperty.call(v, a[i])) added++;
    v[a[i]] = a[i + 1];
  }
  this.store(a[0], Object.assign({}, e || {}, {t: 'hash', v: v}));
  return added;
}

function push(name, a, left) {
  if (a.length < 2) throw wrongArgs(name);
  const e = this.typed(a[0], 'list');
  const list = (e != null) ? e.v.slice() : [];
  for (const value of a.slice(1)) {
    if (left) list.unshift(value);
    else list.push(value);
  }
  this.store(a[0], Object.assign({}, e || {}, {t: 'list', v: list}));
  return list.length;
}

// One command, answered in node_redis's style: the callback (when given)
// gets (err, reply) on a later tick.
LocalKv.prototype.run = function(name, args, callback) {
  let err = null;
  let reply;
  try {
    reply = COMMANDS[name].call(this, flatten(name, args));
  } catch (e) {
    if (!(e instanceof Error) || e.code == null) throw e;
    err = e;
  }
  if (typeof(callback) === 'function') process.nextTick(callback, err, (err != null) ? undefined : reply);
  return true;
};

Object.keys(COMMANDS).forEach((name) => {
  LocalKv.prototype[name] = function(...args) {
    const callback = (typeof(args[args.length - 1]) === 'function') ? args.pop() : undefined;
    return this.run(name, args, callback);
  };
});

// multi(): the commands queued and run in order by exec(callback(err,
// replies)), a command's error in its place among the replies, as
// node_redis gives them. (One process: nothing runs between them.)
LocalKv.prototype.multi = function() {
  const kv = this;
  const queued = [];
  const batch = {
    exec(callback) {
      const replies = queued.map(([name, args]) => {
        try {
          return COMMANDS[name].call(kv, flatten(name, args));
        } catch (e) {
          if (!(e instanceof Error) || e.code == null) throw e;
          return e;
        }
      });
      if (typeof(callback) === 'function') process.nextTick(callback, null, replies);
      return true;
    }
  };
  Object.keys(COMMANDS).filter((n) => n !== 'exec').forEach((name) => {
    batch[name] = (...args) => {
      if (typeof(args[args.length - 1]) === 'function') args.pop();
      queued.push([name, args]);
      return batch;
    };
  });
  return batch;
};

// Expired keys swept, then written now (shutdown, tests).
LocalKv.prototype.close = function() {
  for (const key of Array.from(this.map.keys())) this.entry(key);
  this.file.close();
};

module.exports = LocalKv;
