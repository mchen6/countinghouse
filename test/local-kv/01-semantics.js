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

// The review of B3 (/code-review medium on d18b4e9).
describe('local-kv 01: the review of B3', () => {
  it('a trailing undefined with no callback after it is the callback slot, as node_redis takes it', async () => {
    const kv = new LocalKv({storePath: tmpStore()});
    kv.set('t', 'v', undefined);
    kv.lpush('l', 'x', undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(await run(kv, 'get', 't'), 'v');
    assert.deepStrictEqual(await run(kv, 'lrange', 'l', 0, -1), ['x']);
    kv.close();
  });

  it('never throws out of a command: a bad argument or a malformed stored entry reaches the callback', async () => {
    const storePath = tmpStore();
    fs.writeFileSync(path.join(storePath, 'kv.json'), JSON.stringify({bad: {t: 'hash', v: null}, z: {t: 'zset', v: 'no'}}));
    const kv = new LocalKv({storePath});
    assert.strictEqual(await run(kv, 'hget', 'bad', 'f'), null);
    assert.deepStrictEqual(await run(kv, 'zrange', 'z', 0, -1), []);
    const r = await run(kv, 'set', 'k', Object.create(null));
    assert.ok(typeof(r.error) === 'string', JSON.stringify(r));
    kv.close();
  });

  it('multi: an arity error aborts the whole transaction (EXECABORT), and nothing is written', async () => {
    const kv = new LocalKv({storePath: tmpStore()});
    const err = await new Promise((resolve) => kv.multi().set('m', '1').get().exec((e) => resolve(e)));
    assert.strictEqual(err.message, 'EXECABORT Transaction discarded because of previous errors.');
    assert.strictEqual(await run(kv, 'get', 'm'), null);
    kv.close();
  });

  it('multi: a queued command\'s own callback is called, and multi([[...]]) queues the commands it is given', async () => {
    const kv = new LocalKv({storePath: tmpStore()});
    let cbArgs = null;
    await new Promise((resolve) => kv.multi().set('q', '1', (e, r) => { cbArgs = [e, r]; }).exec(resolve));
    assert.deepStrictEqual(cbArgs, [null, 'OK']);
    const replies = await new Promise((resolve) => kv.multi([['set', 'mx', '1'], ['get', 'mx']]).exec((e, r) => resolve(r)));
    assert.deepStrictEqual(replies, ['OK', '1']);
    kv.close();
  });

  it('sweeps an expired key nobody reads, from memory and from kv.json', async () => {
    let now = 1000000;
    const storePath = tmpStore();
    const kv = new LocalKv({storePath, now: () => now});
    await run(kv, 'set', 'tmp', 'v', 'PX', 10);
    now += 20;
    kv.sweep();
    kv.close();
    assert.ok(!Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(path.join(storePath, 'kv.json'), 'utf8')), 'tmp'));
  });

  it('sees a key another process wrote to the same store, after its reload', async () => {
    const storePath = tmpStore();
    const a = new LocalKv({storePath});
    const b = new LocalKv({storePath});
    await run(a, 'set', 'shared', 'A');
    a.close();
    b.reload();
    assert.strictEqual(await run(b, 'get', 'shared'), 'A');
    b.close();
  });

  it('keeps __proto__ as a key and a hash field, across a restart', async () => {
    const storePath = tmpStore();
    const a = new LocalKv({storePath});
    await run(a, 'set', '__proto__', 'v');
    await run(a, 'hset', 'h', '__proto__', 'x');
    a.close();
    const b = new LocalKv({storePath});
    assert.strictEqual(await run(b, 'get', '__proto__'), 'v');
    assert.strictEqual(await run(b, 'hget', 'h', '__proto__'), 'x');
    b.close();
  });
});
