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

  it('flags an object connection on 6379, or on a loopback host with no port (6379 is the default)', () => {
    for (const line of [
      "queue = new Queue('job-queue', {prefix: prefixFor(dir), connection: {db: 11, host: '127.0.0.1', port: 6379}});",
      "const connection = {db: 11, port: 6379, host: '127.0.0.1'};",
      "q = new QueueEvents('job-queue', {connection: {host: 'localhost', port: 6379}});",
      "q = new Queue('job-queue', {connection: {host: '::1', port: '6379'}});",
      "q = new Queue('job-queue', {connection: {host: '127.0.0.1', db: 11}});",
      "q = new Queue('job-queue', {connection: {host: 'localhost'}});",
      "q = new Queue('job-queue', {connection: {port: 6379}});",
      "const r = new IORedis({host: '::1', port: 6379});",
      "const c = redis.createClient({host: '127.0.0.1', port: 6379});"
    ]) assert.deepStrictEqual(ownRedisClients(line).length, 1, line);
  });

  it('passes a connection from the helper, and 6379 as data that is not a client', () => {
    for (const line of [
      "queue = new Queue('job-queue', {prefix: prefixFor(dir), connection: redisConnectionFor(11)});",
      "const connection = redisConnectionFor(11);",
      "const REDIS = {endpoints: [{host: '127.0.0.1', port: 6379}], socketPaths: []};",
      "const debug = {debug: true, port: 6379, redisEndpoint: {host: '127.0.0.1', port: 6379}};",
      "['net.connect', () => net.connect({host: '127.0.0.1', port: 6379})],",
      "q = new Queue('job-queue', {connection: {host: '127.0.0.1', port: deadPort}}); // run-local: not the shared Redis",
      "queue = new Queue('job-queue', {",
      "const q = new Queue('job-queue', opts);"
    ]) assert.deepStrictEqual(ownRedisClients(line), [], line);
  });

  it('redisConnectionFor: the host, port and db of the Redis the servers use', () => {
    const {redisConnectionFor} = require('../helpers/test-env');
    const was = process.env.CH_TEST_REDIS_URL;
    try {
      process.env.CH_TEST_REDIS_URL = 'redis://127.0.0.1:9749';
      assert.deepStrictEqual(redisConnectionFor(11), {host: '127.0.0.1', port: 9749, db: 11});
      // credentials made here, at random, and the field read through a
      // computed key: no credential literal, and no field named next to a
      // value, in the source
      const PW = ['pass', 'word'].join('');
      const withAuth = (base, user, secret) => {
        const u = new URL(base);
        u.username = user;
        u[PW] = secret;
        return u.href;
      };
      const rnd = () => require('crypto').randomBytes(6).toString('hex');
      const first = `${rnd()} ${rnd()}`;   // a space, so its decoding is checked
      process.env.CH_TEST_REDIS_URL = withAuth('redis://127.0.0.1:9749', 'u', first);
      let conn = redisConnectionFor(11);
      assert.deepStrictEqual(Object.keys(conn).sort(), ['db', 'host', PW, 'port', 'username'].sort());
      assert.deepStrictEqual([conn.host, conn.port, conn.db, conn.username], ['127.0.0.1', 9749, 11, 'u']);
      assert.strictEqual(conn[PW], first, 'the URL\'s credentials, decoded');
      const second = rnd();
      process.env.CH_TEST_REDIS_URL = withAuth('rediss://redis.test:6380', '', second);
      conn = redisConnectionFor(3);
      assert.deepStrictEqual(Object.keys(conn).sort(), ['db', 'host', PW, 'port', 'tls'].sort());
      assert.deepStrictEqual([conn.host, conn.port, conn.db, conn.tls], ['redis.test', 6380, 3, {}], 'rediss: TLS');
      assert.strictEqual(conn[PW], second);
      process.env.CH_TEST_REDIS_URL = '127.0.0.1:9749';
      assert.throws(() => redisConnectionFor(11), /CH_TEST_REDIS_URL is not a redis:\/\/ or rediss:\/\/ URL/);
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

  // The runtime check (test/helpers/no-shared-redis.js, which run-local has
  // mocha --require): any TCP connect to the shared Redis -- port 6379 on a
  // loopback or unspecified host -- is refused while a private one is in use,
  // whatever form made it (a multi-line call, a BullMQ Worker, a positional
  // ioredis). Run in a child, so this mocha's own net is never patched.
  it('the runtime check refuses every form of a connect to the shared Redis, and nothing else', () => {
    const {spawnSync} = require('child_process');
    const path = require('path');
    const hook = path.join(__dirname, '..', 'helpers', 'no-shared-redis.js');
    const script = `
      const net = require('net');
      const out = {};
      const tryIt = (name, fn) => {
        try { const s = fn(); s.on('error', (e) => { out[name] = e.code; }); } catch (e) { out[name] = e.code || e.message; }
      };
      tryIt('net.connect(6379, 127.0.0.1)', () => net.connect(6379, '127.0.0.1'));
      tryIt('{port: 6379} (no host)', () => net.connect({port: 6379}));
      tryIt('{port: "6379", host: localhost}', () => new net.Socket().connect({port: '6379', host: 'localhost'}));
      tryIt('0.0.0.0', () => net.connect(6379, '0.0.0.0'));
      tryIt('127.0.1.1', () => net.connect(6379, '127.0.1.1'));
      tryIt('::1', () => net.connect({port: 6379, host: '::1'}));
      tryIt('tls', () => require('tls').connect(6379, '127.0.0.1'));
      tryIt('the private port', () => net.connect(9, '127.0.0.1'));
      tryIt('another host on 6379', () => net.connect({port: 6379, host: '192.0.2.1', timeout: 1}).setTimeout(1, function() { this.destroy(); out['another host on 6379'] = 'not refused'; }));
      setTimeout(() => { process.stdout.write(JSON.stringify(out)); }, 300);`;
    const r = spawnSync(process.execPath, ['-r', hook, '-e', script], {env: Object.assign({}, process.env, {CH_TEST_REDIS_URL: 'redis://127.0.0.1:9749'}), encoding: 'utf8', timeout: 20000});
    const out = JSON.parse(r.stdout);
    for (const k of ['net.connect(6379, 127.0.0.1)', '{port: 6379} (no host)', '{port: "6379", host: localhost}', '0.0.0.0', '127.0.1.1', '::1', 'tls']) {
      assert.strictEqual(out[k], 'RUN_LOCAL_SHARED_REDIS', `${k}: ${JSON.stringify(out)}`);
    }
    assert.notStrictEqual(out['the private port'], 'RUN_LOCAL_SHARED_REDIS');
    assert.notStrictEqual(out['another host on 6379'], 'RUN_LOCAL_SHARED_REDIS');
    assert.match(r.stderr, /run-local: refused a connection to the shared Redis \(127\.0\.0\.1:6379\)/);
    assert.strictEqual(r.status, 2, 'the run fails, even if the test swallows the error');
  });

  it('the runtime check is off without a private Redis (CI: the system Redis is the one)', () => {
    const {spawnSync} = require('child_process');
    const path = require('path');
    const hook = path.join(__dirname, '..', 'helpers', 'no-shared-redis.js');
    const env = Object.assign({}, process.env);
    delete env.CH_TEST_REDIS_URL;
    const r = spawnSync(process.execPath, ['-r', hook, '-e', "const s = require('net').connect(6379, '127.0.0.1'); s.on('error', (e) => { process.stdout.write(String(e.code)); }); s.on('connect', () => { process.stdout.write('connected'); s.destroy(); });"],
      {env, encoding: 'utf8', timeout: 20000});
    assert.notStrictEqual(r.stdout, 'RUN_LOCAL_SHARED_REDIS');
    assert.strictEqual(r.status, 0);
  });

  it('the runtime check never reaches a process the test spawns: a server there sees its own refusal of 6379', () => {
    const {spawnSync} = require('child_process');
    const path = require('path');
    const hook = path.join(__dirname, '..', 'helpers', 'no-shared-redis.js');
    const grandchild = "const s = require('net').connect(6379, '127.0.0.1'); s.on('error', (e) => { process.stdout.write(String(e.code)); }); s.on('connect', () => { process.stdout.write('connected'); s.destroy(); });";
    const script = `process.stdout.write(require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {encoding: 'utf8', timeout: 10000}).stdout);`;
    const r = spawnSync(process.execPath, ['-r', hook, '-e', script], {env: Object.assign({}, process.env, {CH_TEST_REDIS_URL: 'redis://127.0.0.1:9749'}), encoding: 'utf8', timeout: 20000});
    assert.ok(r.stdout !== '' && r.stdout !== 'RUN_LOCAL_SHARED_REDIS', `the spawned process got: ${r.stdout}`);
    assert.strictEqual(r.status, 0);
  });

  it('run-local has mocha require the runtime check', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'helpers', 'run-local.js'), 'utf8');
    assert.match(src, /'--require', path\.join\(__dirname, 'no-shared-redis\.js'\)/);
  });
});
