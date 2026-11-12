'use strict';

// LM1 B3, Task 5: the commands a module's ctx.redis may name, as the
// runtime computes them (the intersection of redis-commands' list with
// lib/supported-redis-commands.json). The json lists 23 entries, zrange
// twice and zlen, which is not a Redis command, so the live set is 21;
// local-kv implements exactly these.

const assert = require('assert');
const {ALLOWED_COMMANDS} = require('../../lib/redis-api');

describe('local-kv 00: the allowed command set', () => {
  it('is pinned', () => {
    assert.deepStrictEqual(ALLOWED_COMMANDS, ['del', 'exec', 'get', 'hdel', 'hget', 'hgetall', 'hmget', 'hmset', 'hset',
      'llen', 'lpush', 'lrange', 'ltrim', 'mget', 'multi', 'pexpire', 'rpush', 'set', 'zadd', 'zrange', 'zrem']);
    assert.ok(Object.isFrozen(ALLOWED_COMMANDS));
  });
});
