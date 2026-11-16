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

  it('flags an object connection on 6379, any loopback host form, and a BullMQ queue with none (its default)', () => {
    for (const line of [
      "queue = new Queue('job-queue', {prefix: '{cdifJob}', connection: {db: 11, host: '127.0.0.1', port: 6379}});",
      "const connection = {db: 11, port: 6379, host: '127.0.0.1'};",
      "q = new QueueEvents('job-queue', {connection: {host: 'localhost', port: 6379}});",
      "q = new Queue('job-queue', {connection: {host: '::1', port: '6379'}});",
      "q = new Queue('job-queue', {connection: {host: '127.0.0.1', db: 11}});",
      "q = new Queue('job-queue', {connection: {host: 'localhost'}});",
      "q = new Queue('job-queue', {connection: {port: 6379}});",
      "const r = new IORedis({host: '::1', port: 6379});",
      "const c = redis.createClient({host: '127.0.0.1', port: 6379});",
      "q = new Queue('job-queue');",
      "q = new Queue('job-queue', {prefix: '{cdifJob}'});"
    ]) assert.deepStrictEqual(ownRedisClients(line).length, 1, line);
  });

  it('passes a connection from the helper, and 6379 as data that is not a client', () => {
    for (const line of [
      "queue = new Queue('job-queue', {prefix: '{cdifJob}', connection: redisConnectionFor(11)});",
      "const connection = redisConnectionFor(11);",
      "const REDIS = {endpoints: [{host: '127.0.0.1', port: 6379}], socketPaths: []};",
      "const debug = {debug: true, port: 6379, redisEndpoint: {host: '127.0.0.1', port: 6379}};",
      "['net.connect', () => net.connect({host: '127.0.0.1', port: 6379})],",
      "q = new Queue('job-queue', {connection: {host: '127.0.0.1', port: deadPort}}); // run-local: not the shared Redis"
    ]) assert.deepStrictEqual(ownRedisClients(line), [], line);
  });

  it('redisConnectionFor: the host, port and db of the Redis the servers use', () => {
    const {redisConnectionFor} = require('../helpers/test-env');
    const was = process.env.CH_TEST_REDIS_URL;
    try {
      process.env.CH_TEST_REDIS_URL = 'redis://127.0.0.1:9749';
      assert.deepStrictEqual(redisConnectionFor(11), {host: '127.0.0.1', port: 9749, db: 11});
      process.env.CH_TEST_REDIS_URL = 'redis://[::1]:9749';
      assert.deepStrictEqual(redisConnectionFor(11), {host: '::1', port: 9749, db: 11}, 'brackets off an IPv6 host');
      delete process.env.CH_TEST_REDIS_URL;
      assert.deepStrictEqual(redisConnectionFor(11), {host: '127.0.0.1', port: 6379, db: 11}, 'CI: the system Redis');
    } finally {
      if (was == null) delete process.env.CH_TEST_REDIS_URL; else process.env.CH_TEST_REDIS_URL = was;
    }
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
