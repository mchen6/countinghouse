// run-local.js refuses a test file that opens its own Redis client on a
// literal URL, or with a bare createClient() (the shared Redis by default):
// run-local redirects only the servers a test starts, so such a client would
// write the shared Redis while the server read the private one (reviewer,
// 2026-11-12, after test/auth/09 did exactly that). redisUrlFor() is the way.
const assert = require('assert');
const {ownRedisClients} = require('../helpers/run-local');

describe('validation 09: run-local refuses a test with its own Redis client on a literal URL', () => {
  it('flags a literal URL or a bare createClient, and passes redisUrlFor', () => {
    assert.deepStrictEqual(ownRedisClients("const c = redis.createClient('redis://127.0.0.1:6379', {db: 0});").length, 1);
    assert.deepStrictEqual(ownRedisClients('redisClient = redis.createClient();').length, 1);
    assert.deepStrictEqual(ownRedisClients("const p = new RedisMeteringProvider({redisUrl: 'redis://127.0.0.1:6379', redisDb: 0});").length, 1);
    assert.deepStrictEqual(ownRedisClients("const r = new Redis('redis://localhost:6379');").length, 1);
    assert.deepStrictEqual(ownRedisClients("const c = redis.createClient(redisUrlFor(), {db: 0});"), []);
    assert.deepStrictEqual(ownRedisClients("// redis.createClient('redis://127.0.0.1:6379') in a comment"), []);
    assert.deepStrictEqual(ownRedisClients("start(['--store', 'local', '--redisUrl', 'redis://127.0.0.1:6379']);"), [], 'a server argument is not a client');
    assert.deepStrictEqual(ownRedisClients("const c = createClient(`redis://127.0.0.1:${port}`); // run-local: not the shared Redis"), [], 'a dead port says so');
  });

  it('no test in the tree opens its own client on a literal URL any more', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..');
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') walk(p); } else if (e.name.endsWith('.js')) {
          if (p !== __filename && ownRedisClients(fs.readFileSync(p, 'utf8')).length > 0) offenders.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    assert.deepStrictEqual(offenders, []);
  });
});
