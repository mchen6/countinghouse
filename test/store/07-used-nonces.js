'use strict';
// MCP completeness M12 (the design, section 8): the store's usedNonces
// part, which makes a requestState single use. A state's nonce is
// remembered until the state expires: in Redis (SET NX with an expiry, on
// a db of its own) so that every server of a deployment refuses a replay;
// under --store local in a file of the store (<storePath>/used-nonces.json),
// written before the answer, so a runtime restarted inside a state's five
// minutes, or another process on the same store, refuses it too (the
// reviewer's condition on M12: the state's key is derived from the secret on
// disk and survives the restart, so its nonce must). A store that cannot
// say whether a nonce was used rejects, and the retry is refused: never
// "first use" by default.
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

  describe('--store local: a file of the store', () => {
    it('a nonce is first used once; no Redis client is made; it is written to used-nonces.json, the owner\'s only, before the answer', async () => {
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
        const fs = require('fs');
        const file = require('path').join(process.env.STORE_DIR, 'used-nonces.json');
        // on disk already: nothing waits for a debounced write
        const onDisk = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort();
        return {first, again, other, past, created: created.length, onDisk, mode: (fs.statSync(file).mode & 0o777).toString(8),
          files: fs.readdirSync(process.env.STORE_DIR).filter((n) => !n.startsWith('.')).sort()};`, {STORE_DIR: dir});
      assert.deepStrictEqual(out, {first: true, again: false, other: true, past: false, created: 0, onDisk: ['n-one', 'n-two'],
        mode: process.platform === 'win32' ? out.mode : '600', files: ['used-nonces.json']});
    });

    // the reviewer's condition: the replay §8 names, across a restart
    it('a runtime restarted inside a state\'s five minutes still refuses its nonce; so does another process on the same store', async () => {
      dir = mkdtemp('ch-store07-');
      const use = `
        const used = lib('store').createStore({store: 'local', storePath: process.env.STORE_DIR}).usedNonces;
        return await used.use('n-restart', Number(process.env.UNTIL));`;
      const until = String(Date.now() + 5 * 60 * 1000);
      assert.strictEqual(await inChild(use, {STORE_DIR: dir, UNTIL: until}), true, 'the first runtime');
      assert.strictEqual(await inChild(use, {STORE_DIR: dir, UNTIL: until}), false, 'the next one, after a restart');
      // two at once on one store: exactly one first use
      const race = await Promise.all([1, 2, 3].map(() => inChild(`
        const used = lib('store').createStore({store: 'local', storePath: process.env.STORE_DIR}).usedNonces;
        return await used.use('n-race', Number(process.env.UNTIL));`, {STORE_DIR: dir, UNTIL: until})));
      assert.deepStrictEqual(race.slice().sort(), [false, false, true]);
    });

    // Independent of the runner's speed (#385: on a loaded runner the first
    // use's write took past a 300 ms expiry, so the next use swept it before
    // the file was read). A use writes before it answers, so a short real
    // margin can be spent by the writes: the short expiry is a minute out,
    // and the child's clock (Date.now, which the part and the file read)
    // then jumps past it. It runs on real time otherwise, so the store
    // lock's own deadlines still hold.
    it('a nonce is kept until its own expiry; the next use after it drops every expired one from the file', async () => {
      dir = mkdtemp('ch-store07-');
      const out = await inChild(`
        const real = Date.now;
        let jump = 0;
        Date.now = () => real() + jump;
        const fs = require('fs');
        const file = require('path').join(process.env.STORE_DIR, 'used-nonces.json');
        const used = lib('store').createStore({store: 'local', storePath: process.env.STORE_DIR}).usedNonces;
        const keys = () => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort();
        const short = Date.now() + 60000;
        const firsts = [await used.use('n-long', Date.now() + 600000), await used.use('n-short', short), await used.use('n-gone', short)];
        const before = keys();
        jump = short + 1 - real();
        // past its expiry its state is refused as expired; the name is free,
        // and the next use sweeps out every other expired one (n-gone)
        const again = await used.use('n-short', Date.now() + 60000);
        await used.use('n-third', Date.now() + 60000);
        return {firsts, before, again, after: keys()};`, {STORE_DIR: dir});
      assert.deepStrictEqual(out, {firsts: [true, true, true], before: ['n-gone', 'n-long', 'n-short'], again: true, after: ['n-long', 'n-short', 'n-third']});
    });

    it('a store it cannot write rejects: never a first use by default', async function() {
      if (process.platform === 'win32' || (typeof(process.getuid) === 'function' && process.getuid() === 0)) return this.skip();
      dir = mkdtemp('ch-store07-');
      const out = await inChild(`
        const fs = require('fs');
        const used = lib('store').createStore({store: 'local', storePath: process.env.STORE_DIR}).usedNonces;
        await used.use('n-ok', Date.now() + 60000);
        fs.chmodSync(process.env.STORE_DIR, 0o500);
        let answer;
        try { answer = {resolved: await used.use('n-ro', Date.now() + 60000)}; } catch (e) { answer = {rejected: true}; }
        fs.chmodSync(process.env.STORE_DIR, 0o700);
        return answer;`, {STORE_DIR: dir});
      assert.deepStrictEqual(out, {rejected: true});
    });

    it('a nonce is one here too, and is remembered 15 minutes at most: anything else is no first use', async () => {
      dir = mkdtemp('ch-store07-');
      const out = await inChild(`
        const used = lib('store').createStore({store: 'local', storePath: process.env.STORE_DIR}).usedNonces;
        const soon = Date.now() + 5000;
        const answers = [];
        for (const bad of ['', 'a b', 'x'.repeat(65), 'a:b', null, 7]) answers.push(await used.use(bad, soon));
        for (const when of [NaN, null, Date.now() + 3600 * 1000]) answers.push(await used.use('t-shape', when));
        // within the bound it is a first use, once
        return {answers, good: [await used.use('t-shape', Date.now() + 14 * 60 * 1000), await used.use('t-shape', Date.now() + 14 * 60 * 1000)]};`, {STORE_DIR: dir});
      assert.deepStrictEqual(out, {answers: new Array(9).fill(false), good: [true, false]});
    });

    it('it works with request-state\'s consume: a verified state is good once', async () => {
      dir = mkdtemp('ch-store07-');
      const out = await inChild(`
        const rs = lib('request-state');
        const key = require('crypto').randomBytes(32);
        const b = {caller: 'u_x', session: '', method: 'tools/call', tool: 't', arguments: {}};
        const used = lib('store').createStore({store: 'local', storePath: process.env.STORE_DIR}).usedNonces;
        const v = rs.verify(key, rs.mint(key, {question: 'q', round: 1, callRound: 1, answers: {}}, b), b);
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
        // a margin the round trips can't spend (#385's lesson), and the wait
        // is until past it, not a fixed time
        const until = Date.now() + 5000;
        const first = await one.use(n, until);
        const again = await one.use(n, until);
        const elsewhere = await two.use(n, until);
        const client = raw();
        const ttl = await call(client, 'pttl', 'requeststate:nonce:' + n);
        const value = await call(client, 'get', 'requeststate:nonce:' + n);
        while (Date.now() <= until + 100) await new Promise((r) => setTimeout(r, until + 101 - Date.now()));
        const kept = await call(client, 'exists', 'requeststate:nonce:' + n);
        // past its expiry a state is refused as expired; its nonce need not be known
        const late = await one.use(n, until);
        return {first, again, elsewhere, ttlOk: ttl > 0 && ttl <= 5000, value, kept, late};`);
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

    it('a Redis that accepts and never answers rejects, promptly', async () => {
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

    // my /code-review: the case above ends by the client's own first-connect
    // bound, with no deadline of the part's at all. The deadline is for a
    // Redis that was there (its client ready) and stops answering a command
    // it was sent: without it that use() would never settle.
    it('a Redis that was ready and then answers no more: the part\'s own deadline rejects it, USED_NONCE_TIMEOUT', async () => {
      // a stand-in that speaks enough RESP to make a client ready (INFO,
      // SELECT, anything else +OK), and never answers a SET
      const sockets = new Set();
      const standIn = net.createServer((socket) => {
        sockets.add(socket);
        let pending = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          pending = Buffer.concat([pending, chunk]);
          for (;;) {
            // one command: *<n>\r\n then n times $<len>\r\n<bytes>\r\n
            const text = pending.toString('latin1');
            const head = /^\*(\d+)\r\n/.exec(text);
            if (head == null) return;
            let at = head[0].length;
            const parts = [];
            for (let i = 0; i < Number(head[1]); i++) {
              const len = /^\$(\d+)\r\n/.exec(text.slice(at));
              if (len == null || text.length < at + len[0].length + Number(len[1]) + 2) return;
              parts.push(text.slice(at + len[0].length, at + len[0].length + Number(len[1])));
              at += len[0].length + Number(len[1]) + 2;
            }
            pending = pending.subarray(at);
            const name = String(parts[0]).toLowerCase();
            if (name === 'set') continue;   // never answered
            if (name === 'info') {
              const body = '# Server\r\nredis_version:6.2.0\r\nloading:0\r\nrole:master\r\n';
              socket.write(`$${Buffer.byteLength(body)}\r\n${body}\r\n`);
            } else {
              socket.write('+OK\r\n');
            }
          }
        });
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise((resolve) => standIn.listen(0, '127.0.0.1', resolve));
      try {
        const out = await inChild(`
          const used = lib('store').createStore({store: 'redis', redisUrl: 'redis://127.0.0.1:${standIn.address().port}'}).usedNonces;
          // let the client become ready first: past redis-resilient's first-connect bound, its queue is off
          await new Promise((r) => setTimeout(r, 2500));
          const t0 = Date.now();
          let answer;
          try { answer = {resolved: await used.use('t-silent', Date.now() + 60000)}; } catch (e) { answer = {rejected: true, code: e.code || null}; }
          return Object.assign(answer, {after: Date.now() - t0});`);
        assert.strictEqual(out.rejected, true, JSON.stringify(out));
        assert.strictEqual(out.code, 'USED_NONCE_TIMEOUT', JSON.stringify(out));
        assert.ok(out.after >= 1900 && out.after < 4000, `its 2 s deadline: ${out.after} ms`);
      } finally {
        for (const s of sockets) s.destroy();
        standIn.close();
      }
    });
  });
});
