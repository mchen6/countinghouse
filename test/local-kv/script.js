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
  ['exec']
];
