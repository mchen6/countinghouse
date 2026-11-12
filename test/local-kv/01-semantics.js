'use strict';

// LM1 B3, Task 6: LocalKv, the --store local client behind a module's
// ctx.redis: the allowed commands with Redis's answers, expiry, multi/exec,
// and persistence in <storePath>/kv.json.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LocalKv = require('../../lib/local-kv');
const {ALLOWED_COMMANDS} = require('../../lib/redis-api');

function tmpStore() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-kv-01-')); }
function run(kv, cmd, ...args) {
  return new Promise((resolve) => kv[cmd](...args, (err, reply) => resolve(err != null ? {error: err.message} : reply)));
}

describe('local-kv 01: LocalKv semantics', () => {
  it('has a method for every allowed command', () => {
    const kv = new LocalKv({storePath: tmpStore()});
    for (const c of ALLOWED_COMMANDS) assert.strictEqual(typeof(kv[c]), 'function', c);
    kv.close();
  });

  it('answers strings, hashes, lists and sorted sets as Redis does', async () => {
    const kv = new LocalKv({storePath: tmpStore()});
    assert.strictEqual(await run(kv, 'set', 's', 1), 'OK');
    assert.strictEqual(await run(kv, 'get', 's'), '1');
    assert.strictEqual(await run(kv, 'set', 's', 'x', 'NX'), null);
    assert.strictEqual(await run(kv, 'hset', 'h', 'a', '1', 'b', '2'), 2);
    assert.deepStrictEqual(await run(kv, 'hgetall', 'h'), {a: '1', b: '2'});
    assert.strictEqual(await run(kv, 'hgetall', 'none'), null);
    assert.strictEqual(await run(kv, 'rpush', 'l', 'a', 'b', 'c'), 3);
    assert.deepStrictEqual(await run(kv, 'lrange', 'l', -2, -1), ['b', 'c']);
    assert.strictEqual(await run(kv, 'zadd', 'z', 2, 'b', 1, 'a'), 2);
    assert.deepStrictEqual(await run(kv, 'zrange', 'z', 0, -1, 'WITHSCORES'), ['a', '1', 'b', '2']);
    assert.deepStrictEqual(await run(kv, 'get', 'h'), {error: 'WRONGTYPE Operation against a key holding the wrong kind of value'});
    kv.close();
  });

  it('expires a key after pexpire, and deletes at once for a non-positive time', async () => {
    let now = 1000000;
    const kv = new LocalKv({storePath: tmpStore(), now: () => now});
    await run(kv, 'set', 'k', 'v');
    assert.strictEqual(await run(kv, 'pexpire', 'k', 500), 1);
    now += 499;
    assert.strictEqual(await run(kv, 'get', 'k'), 'v');
    now += 2;
    assert.strictEqual(await run(kv, 'get', 'k'), null);
    await run(kv, 'set', 'k2', 'v');
    assert.strictEqual(await run(kv, 'pexpire', 'k2', 0), 1);
    assert.strictEqual(await run(kv, 'get', 'k2'), null);
    kv.close();
  });

  it('multi() queues commands and exec answers them in order', async () => {
    const kv = new LocalKv({storePath: tmpStore()});
    const replies = await new Promise((resolve, reject) => kv.multi().lpush('d', 'x').lpush('d', 'y').ltrim('d', 0, 0).lrange('d', 0, -1)
      .exec((err, r) => (err ? reject(err) : resolve(r))));
    assert.deepStrictEqual(replies, [1, 2, 'OK', ['y']]);
    kv.close();
  });

  it('persists in kv.json, expiry included, for a new LocalKv on the same store', async () => {
    const storePath = tmpStore();
    const a = new LocalKv({storePath});
    await run(a, 'hset', 'h', 'f', 'v');
    await run(a, 'set', 'gone', 'v');
    await run(a, 'pexpire', 'gone', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    a.close();
    const b = new LocalKv({storePath});
    assert.strictEqual(await run(b, 'hget', 'h', 'f'), 'v');
    assert.strictEqual(await run(b, 'get', 'gone'), null);
    b.close();
    assert.ok(fs.existsSync(path.join(storePath, 'kv.json')));
  });

  it('answers the whole shared script without throwing', async () => {
    const kv = new LocalKv({storePath: tmpStore()});
    for (const [cmd, ...args] of require('./script')) await run(kv, cmd, ...args);
    kv.close();
  });
});
