'use strict';
// MCP completeness M12 (the design, section 8): the store's usedNonces
// part, which makes a requestState single use. A state's nonce is
// remembered until the state expires: in Redis (SET NX with an expiry, on
// a db of its own) so that every server of a deployment refuses a replay,
// in memory under --store local. A store that cannot say whether a nonce
// was used rejects, and the retry is refused: never "first use" by default.
//
// Each case is a child process (a store's clients live as long as their
// process); the Redis cases use the harness's Redis (CH_TEST_REDIS_URL, or
// CI's on 6379).
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const {spawn} = require('child_process');
const {redisUrlFor} = require('../helpers/test-env');
const {mkdtemp} = require('../helpers/test-tmp');

const ROOT = path.resolve(__dirname, '../..');
const DB = 14;

// Runs `body` (an async function's body; `lib(name)` requires from lib/,
// `raw()` is a plain client on the part's db) in a child; -> what it returns.
function inChild(body, env = {}) {
  const script = `
    const lib = (name) => require(${JSON.stringify(path.join(ROOT, 'lib'))} + '/' + name);
    const redis = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'redis'))});
    const raw = () => redis.createClient(process.env.TEST_REDIS, {db: ${DB}});
    const call = (client, cmd, ...args) => new Promise((res, rej) => client[cmd](...args, (e, r) => (e ? rej(e) : res(r))));
    (async () => { ${body} })().then((v) => { process.stdout.write('OUT ' + JSON.stringify(v) + '\\n'); process.exit(0); },
      (e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {env: Object.assign({}, process.env, {TEST_REDIS: redisUrlFor()}, env), stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('exit', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('OUT '));
      if (line == null) return reject(new Error(`no output: ${out} ${err}`));
      return resolve(JSON.parse(line.slice(4)));
    });
  });
}

describe('store 07: the used nonces of a requestState (MCP completeness M12)', function() {
  this.timeout(60000);
  let dir = null;
  afterEach(() => { if (dir != null) fs.rmSync(dir, {recursive: true, force: true}); dir = null; });

  describe('--store local: memory', () => {
    it('a nonce is first used once; no Redis client is made, and nothing is written', async () => {
      dir = mkdtemp('ch-store07-');
      const out = await inChild(`
        const redis = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'redis'))});
        const created = [];
        const real = redis.createClient;
        redis.createClient = (...a) => { created.push(a); return real(...a); };
        const used = lib('store').createStore({store: 'local', storePath: ${JSON.stringify('DIR')}.replace('DIR', process.env.STORE_DIR)}).usedNonces;
        const soon = Date.now() + 60000;
        const first = await used.use('n-one', soon);
        const again = await used.use('n-one', soon);
        const other = await used.use('n-two', soon);
        const past = await used.use('n-late', Date.now() - 1);
        return {first, again, other, past, created: created.length, files: require('fs').readdirSync(process.env.STORE_DIR)};`, {STORE_DIR: dir});
      assert.deepStrictEqual(out, {first: true, again: false, other: true, past: false, created: 0, files: []});
    });

    it('it works with request-state\'s consume: a verified state is good once', async () => {
      dir = mkdtemp('ch-store07-');
      const out = await inChild(`
        const rs = lib('request-state');
        const key = require('crypto').randomBytes(32);
        const b = {caller: 'u_x', session: '', method: 'tools/call', tool: 't', arguments: {}};
        const used = lib('store').createStore({store: 'local', storePath: process.env.STORE_DIR}).usedNonces;
        const v = rs.verify(key, rs.mint(key, {question: 'q', round: 1, answers: {}}, b), b);
        return [await rs.consume(used, v), await rs.consume(used, v)];`, {STORE_DIR: dir});
      assert.deepStrictEqual(out, [true, false]);
    });
  });

  describe('--store redis', () => {
    const nonce = () => `t${require('crypto').randomBytes(12).toString('base64url')}`;

    it('the client is made when the part is first used, on db 14, and not before', async () => {
      const out = await inChild(`
        const redis = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'redis'))});
        const created = [];
        const real = redis.createClient;
        redis.createClient = (url, opts, ...rest) => { created.push(opts != null && opts.db != null ? opts.db : 0); return real(url, opts, ...rest); };
        lib('request-state');
        const store = lib('store').createStore({store: 'redis', redisUrl: process.env.TEST_REDIS});
        const before = created.slice();
        void store.usedNonces;
        void store.usedNonces;
        return {before, after: created};`);
      assert.deepStrictEqual(out, {before: [], after: [DB]});
    });

    it('SET NX with the state\'s own expiry: first use once, for every server that shares the Redis, until it expires', async () => {
      const n = nonce();
      const out = await inChild(`
        const one = lib('store').createStore({store: 'redis', redisUrl: process.env.TEST_REDIS}).usedNonces;
        const two = lib('store').createStore({store: 'redis', redisUrl: process.env.TEST_REDIS}).usedNonces;
        const n = ${JSON.stringify(n)};
        const until = Date.now() + 1500;
        const first = await one.use(n, until);
        const again = await one.use(n, until);
        const elsewhere = await two.use(n, until);
        const client = raw();
        const ttl = await call(client, 'pttl', 'requeststate:nonce:' + n);
        const value = await call(client, 'get', 'requeststate:nonce:' + n);
        await new Promise((r) => setTimeout(r, 1700));
        const kept = await call(client, 'exists', 'requeststate:nonce:' + n);
        // past its expiry a state is refused as expired; its nonce need not be known
        const late = await one.use(n, until);
        return {first, again, elsewhere, ttlOk: ttl > 0 && ttl <= 1500, value, kept, late};`);
      assert.deepStrictEqual(out, {first: true, again: false, elsewhere: false, ttlOk: true, value: '1', kept: 0, late: false});
    });

    it('a nonce is a key\'s name only as a nonce: anything else is refused, and nothing is stored', async () => {
      const out = await inChild(`
        const used = lib('store').createStore({store: 'redis', redisUrl: process.env.TEST_REDIS}).usedNonces;
        const soon = Date.now() + 5000;
        const answers = [];
        for (const bad of ['', 'a b', 'x'.repeat(65), 'a\\nb', 'a:b', null, 7, {}]) answers.push(await used.use(bad, soon));
        for (const when of [NaN, 'soon', null, Date.now() - 1, Date.now() + 3600 * 1000]) answers.push(await used.use('t-shape', when));
        const client = raw();
        return {answers, stored: await call(client, 'exists', 'requeststate:nonce:t-shape')};`);
      assert.deepStrictEqual(out.answers, new Array(13).fill(false));
      assert.strictEqual(out.stored, 0);
    });

    it('a Redis that is not there rejects, promptly: the retry is refused, never taken as a first use', async () => {
      const out = await inChild(`
        const used = lib('store').createStore({store: 'redis', redisUrl: 'redis://127.0.0.1:1'}).usedNonces;
        if (used == null || typeof(used.use) !== 'function') throw new Error('no usedNonces part');
        const t0 = Date.now();
        let answer;
        try { answer = {resolved: await used.use('t-down', Date.now() + 5000)}; } catch (e) { answer = {rejected: true, code: e.code || null}; }
        return Object.assign(answer, {quick: Date.now() - t0 < 6000});`);
      assert.strictEqual(out.rejected, true, JSON.stringify(out));
      assert.strictEqual(out.quick, true);
    });

    it('a Redis that accepts and never answers rejects within the part\'s deadline', async () => {
      const silent = net.createServer(() => {});
      await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
      try {
        const out = await inChild(`
          const used = lib('store').createStore({store: 'redis', redisUrl: 'redis://127.0.0.1:${silent.address().port}'}).usedNonces;
          if (used == null || typeof(used.use) !== 'function') throw new Error('no usedNonces part');
          const t0 = Date.now();
          let answer;
          try { answer = {resolved: await used.use('t-hung', Date.now() + 5000)}; } catch (e) { answer = {rejected: true}; }
          return Object.assign(answer, {quick: Date.now() - t0 < 6000});`);
        assert.deepStrictEqual(out, {rejected: true, quick: true});
      } finally {
        silent.close();
      }
    });
  });
});
