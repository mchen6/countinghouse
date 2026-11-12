'use strict';

// One script of ctx.redis commands, run against Redis (02-differential) and
// against LocalKv (01-semantics checks a few answers by hand): each step is
// [command, ...args]; an answer is the reply, or {error} with the message.

module.exports = [
  ['set', 's', 'v1'], ['get', 's'], ['set', 's', 'v2', 'NX'], ['set', 's', 'v3', 'XX'], ['get', 's'],
  ['set', 'n', 7], ['get', 'n'], ['mget', 's', 'n', 'missing'], ['get', 'missing'],
  ['set', 'nx', 'a', 'NX'], ['set', 'xx', 'a', 'XX'], ['get', 'xx'],
  ['set', 'bad', 'v', 'NOPE'],
  ['hset', 'h', 'f1', 'a'], ['hset', 'h', 'f1', 'b', 'f2', 'c'], ['hget', 'h', 'f1'], ['hmget', 'h', 'f1', 'f9', 'f2'],
  ['hmset', 'h2', 'x', '1', 'y', '2'], ['hgetall', 'h2'], ['hgetall', 'nohash'], ['hdel', 'h2', 'x', 'zz'], ['hgetall', 'h2'],
  ['hget', 'nohash', 'f'],
  ['get', 'h'], ['lpush', 'h', 'x'], ['hget', 's', 'f'],
  ['rpush', 'l', 'a', 'b', 'c'], ['lpush', 'l', 'z'], ['llen', 'l'], ['lrange', 'l', 0, -1], ['lrange', 'l', -2, -1],
  ['lrange', 'l', 5, 10], ['lrange', 'l', 1, 100], ['ltrim', 'l', 1, 2], ['lrange', 'l', 0, -1],
  ['ltrim', 'l', 10, 20], ['llen', 'l'], ['lrange', 'nolist', 0, -1], ['llen', 'nolist'],
  ['zadd', 'z', 3, 'c', 1, 'a', 2, 'b'], ['zadd', 'z', 5, 'a'], ['zrange', 'z', 0, -1], ['zrange', 'z', 0, -1, 'WITHSCORES'],
  ['zrange', 'z', -1, -1], ['zrem', 'z', 'a', 'nope'], ['zrange', 'z', 0, -1], ['zadd', 'z', 'notanumber', 'x'],
  ['pexpire', 's', 100000], ['pexpire', 'missing', 1000], ['pexpire', 's', 'soon'], ['pexpire', 'n', -1], ['get', 'n'],
  ['del', 's', 'h', 'missing'], ['get', 's'],
  ['get'], ['hset', 'h3', 'f'], ['lrange', 'l', 'a', 'b'],
  ['exec'],
  // the review of B3: argument types as node_redis takes them, SET/ZADD/
  // PEXPIRE options, Redis's integers and floats, __proto__ as a key
  ['set', 'nul', null], ['set', 'obj', {a: 1}], ['set', 'np', Object.create(null)], ['hset', 'ho', {a: '1'}],
  ['hmset', 'hm', {a: '1', b: '2'}], ['hgetall', 'hm'], ['set', 'bool', true], ['get', 'bool'], ['del', ['bool', 'hm']],
  ['set', 'e', 'v', 'EX', 10, 'PX', 100], ['set', 'k1', 'v', 'PX', 100000], ['set', 'k1', 'v2', 'KEEPTTL'], ['set', 'k1', 'v3', 'GET'],
  ['set', 'nope', 'v', 'GET'], ['set', 'pa', 'v', 'PXAT', 99999999999999], ['get', 'pa'], ['set', 'ea', 'v', 'EXAT', 1], ['get', 'ea'],
  ['set', 'h2', 'v', 'GET'],
  ['zadd', 'zz', 'NX', 1, 'a'], ['zadd', 'zz', 'NX', 5, 'a'], ['zadd', 'zz', 'XX', 5, 'a'], ['zadd', 'zz', 'XX', 1, 'b'],
  ['zadd', 'zz', 'CH', 6, 'a', 1, 'c'], ['zadd', 'zz', 'GT', 2, 'a'], ['zadd', 'zz', 'LT', 'CH', 2, 'a'], ['zadd', 'zz', 'INCR', 3, 'a'],
  ['zadd', 'zz', 'INCR', 1, 'a', 2, 'b'], ['zadd', 'zz', 'NX', 'XX', 1, 'a'], ['zadd', 'zz', 'GT', 'NX', 1, 'a'],
  ['zadd', 'zz', ' 1', 'd'], ['zadd', 'zz', 'infinity', 'd'], ['zadd', 'zz', '-inf', 'e'], ['zrange', 'zz', 0, -1, 'WITHSCORES'],
  ['set', 'px', 'v'], ['pexpire', 'px', 100000, 'XX'], ['pexpire', 'px', 100000, 'NX'], ['pexpire', 'px', 100000, 'NX'],
  ['pexpire', 'px', 200000, 'GT'], ['pexpire', 'px', 100, 'GT'], ['pexpire', 'px', 50000, 'LT'], ['pexpire', 'px', 1, 'NX', 'XX'],
  ['rpush', 'il', 'a', 'b', 'c'], ['lrange', 'il', '007', '1'], ['lrange', 'il', 0, '9007199254740993'], ['lrange', 'il', '-0', 1],
  ['lrange', 'il', '+1', 2], ['lrange', 'il', 0, '9223372036854775808'],
  ['hset', 'hp', '__proto__', 'x'], ['hget', 'hp', '__proto__'], ['hset', 'hp', '__proto__', 'y'], ['set', '__proto__', 'v'], ['get', '__proto__']
];
