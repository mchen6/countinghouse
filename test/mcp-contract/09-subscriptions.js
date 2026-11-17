'use strict';
// subscriptions/listen for notifications/tools/list_changed (#231), server
// free: the hub (lib/mcp/subscriptions.js) with a tool list the test sets,
// and the /mcp route on an Express app of its own, read as the SSE stream it
// answers with. From the 2026-07-28 spec (basic/patterns/subscriptions.md):
// the server "MUST send notifications/subscriptions/acknowledged as the first
// message carrying the subscription's ID", "MUST NOT send notification types
// the client has not explicitly requested", and carries
// _meta["io.modelcontextprotocol/subscriptionId"] (the listen request's id)
// on each; closing the stream cancels; a graceful end is a result with
// resultType "complete".
const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const {createHub, SUBSCRIPTION_ID_KEY} = require('../../lib/mcp/subscriptions');

const V = '2026-07-28';
const META = {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 3000) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await tick(10);
  return test();
};

describe('subscriptions/listen (#231)', () => {
  describe('the hub', () => {
    let tools;
    let hub;
    beforeEach(() => {
      tools = [{name: 'a'}];
      hub = createHub({listTools: async() => tools, settleMs: 5});
    });
    const listener = (id, filter, key = 'k') => {
      const got = [];
      let finished = 0;
      const opened = hub.open({id, appKey: key, filter, write: (m) => got.push(m), finish: () => { finished += 1; }});
      return {got, opened, finished: () => finished};
    };

    it('a change to the listed tools sends one list_changed carrying the subscription id; no change sends none', async() => {
      const l = listener(7, {toolsListChanged: true});
      assert.strictEqual(l.opened.ok, true);
      await tick();
      hub.changed();
      await tick();
      assert.deepStrictEqual(l.got, [], 'the same list: nothing');
      tools = [{name: 'a'}, {name: 'b'}];
      hub.changed();
      assert.ok(await until(() => l.got.length === 1));
      assert.deepStrictEqual(l.got[0], {jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {_meta: {[SUBSCRIPTION_ID_KEY]: 7}}});
    });

    it('a subscription that did not ask for toolsListChanged is never sent one', async() => {
      const l = listener(8, {});
      await tick();
      tools = [{name: 'z'}];
      hub.changed();
      await tick(60);
      assert.deepStrictEqual(l.got, []);
    });

    it('a closed subscription is sent nothing more', async() => {
      const l = listener(9, {toolsListChanged: true});
      await tick();
      l.opened.close();
      tools = [{name: 'z'}];
      hub.changed();
      await tick(60);
      assert.deepStrictEqual(l.got, []);
      assert.strictEqual(hub.count('k'), 0);
    });

    it('at most 8 open per key; another key is counted apart', () => {
      for (let i = 0; i < 8; i++) assert.strictEqual(listener(i, {toolsListChanged: true}).opened.ok, true);
      assert.strictEqual(listener(99, {toolsListChanged: true}).opened.ok, false);
      assert.strictEqual(listener(100, {toolsListChanged: true}, 'other').opened.ok, true);
    });

    it('at most maxTotal open across every key', () => {
      hub = createHub({listTools: async() => tools, settleMs: 5, maxTotal: 3});
      assert.strictEqual(listener(1, {}, 'a').opened.ok, true);
      assert.strictEqual(listener(2, {}, 'b').opened.ok, true);
      assert.strictEqual(listener(3, {}, 'c').opened.ok, true);
      const fourth = listener(4, {}, 'd').opened;
      assert.strictEqual(fourth.ok, false);
      assert.strictEqual(fourth.reason, 'total');
    });

    it('endAll ends every subscription once, gracefully', () => {
      const a = listener(1, {toolsListChanged: true});
      const b = listener(2, {});
      hub.endAll();
      hub.endAll();
      assert.strictEqual(a.finished(), 1);
      assert.strictEqual(b.finished(), 1);
      assert.strictEqual(hub.count('k'), 0);
    });
  });

  describe('the /mcp route: an SSE stream', () => {
    let tools;
    let hub;
    let server;
    let port;
    // the caller's key is resolved as tasks/* resolve it: here a --debugKey
    // server's one key, set in the hook and put back after (memory rule:
    // options in hooks, never at load)
    const options = require('../../lib/cli-options');
    const KEY = 'listen-test-key';
    let saved;
    before((done) => {
      saved = {debug: options.debug, debugKey: options.debugKey};
      options.debug = true;
      options.debugKey = KEY;
      tools = [{name: 'a'}];
      hub = createHub({listTools: async() => tools, settleMs: 5});
      const app = express();
      app.use(express.json());
      app.use('/mcp', require('../../lib/routes/mcp')(null, null, hub));
      server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
    });
    after((done) => {
      options.debug = saved.debug;
      options.debugKey = saved.debugKey;
      hub.endAll();
      server.close(() => done());
    });

    // POSTs a listen; resolves once the response starts, with the events read
    // so far kept in `events` (each SSE data line, parsed) and `res`.
    const listen = (body, headers = {'MCP-Protocol-Version': V, 'Mcp-Method': 'subscriptions/listen', 'X-CH-Key': KEY}) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: Object.assign({'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data)}, headers)}, (res) => {
        const out = {res, req, events: [], raw: '', ended: false};
        res.setEncoding('utf8');
        res.on('data', (c) => {
          out.raw += c;
          let i;
          while ((i = out.raw.indexOf('\n\n')) >= 0) {
            const block = out.raw.slice(0, i);
            out.raw = out.raw.slice(i + 2);
            const line = block.split('\n').find((l) => l.startsWith('data: '));
            if (line != null) out.events.push(JSON.parse(line.slice(6)));
          }
        });
        res.on('end', () => { out.ended = true; });
        resolve(out);
      });
      req.on('error', reject);
      req.end(data);
    });
    const body = (id, notifications = {toolsListChanged: true}) => ({jsonrpc: '2.0', id, method: 'subscriptions/listen', params: {_meta: META, notifications}});

    it('answers text/event-stream: the acknowledgement first, then a list_changed with the id, then the graceful end', async() => {
      // (prompts' list notices are served since M8; a kind that is not, is left out)
      const s = await listen(body(41, {toolsListChanged: true, promptsListChanged: true, elicitationsListChanged: true}));
      assert.strictEqual(s.res.statusCode, 200);
      assert.match(String(s.res.headers['content-type']), /^text\/event-stream/);
      assert.strictEqual(s.res.headers['x-accel-buffering'], 'no');
      assert.ok(await until(() => s.events.length >= 1));
      assert.deepStrictEqual(s.events[0], {jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
        params: {notifications: {toolsListChanged: true, promptsListChanged: true}, _meta: {[SUBSCRIPTION_ID_KEY]: 41}}}, 'only what is served is acknowledged');
      await tick();
      tools = [{name: 'a'}, {name: 'b'}];
      hub.changed();
      assert.ok(await until(() => s.events.length >= 2));
      assert.strictEqual(s.events[1].method, 'notifications/tools/list_changed');
      assert.strictEqual(s.events[1].params._meta[SUBSCRIPTION_ID_KEY], 41);
      hub.endAll();
      assert.ok(await until(() => s.ended));
      const last = s.events[s.events.length - 1];
      assert.strictEqual(last.id, 41);
      assert.strictEqual(last.result.resultType, 'complete');
      assert.strictEqual(last.result._meta[SUBSCRIPTION_ID_KEY], 41);
    });

    it('closing the stream cancels the subscription', async() => {
      const s = await listen(body(42));
      assert.ok(await until(() => s.events.length >= 1));
      assert.strictEqual(hub.count(KEY), 1);
      s.req.destroy();
      assert.ok(await until(() => hub.count(KEY) === 0));
    });

    it('a legacy listen is an unknown method; params without notifications is -32602, 400', async() => {
      const legacy = await listen({jsonrpc: '2.0', id: 43, method: 'subscriptions/listen', params: {notifications: {toolsListChanged: true}}}, {});
      assert.strictEqual(legacy.res.statusCode, 200);
      assert.ok(await until(() => legacy.ended));
      const bad = await listen({jsonrpc: '2.0', id: 44, method: 'subscriptions/listen', params: {_meta: META}});
      assert.strictEqual(bad.res.statusCode, 400);
    });

    it('a ninth open listen for one key: 429', async() => {
      const open = [];
      for (let i = 0; i < 8; i++) open.push(await listen(body(50 + i)));
      assert.ok(await until(() => open.every((s) => s.events.length >= 1)));
      const ninth = await listen(body(60));
      assert.strictEqual(ninth.res.statusCode, 429);
      for (const s of open) s.req.destroy();
      assert.ok(await until(() => hub.count(KEY) === 0));
    });

    it('a listen with no key, or a key that is not one, is refused before any stream opens, and counts nothing', async() => {
      const H = {'MCP-Protocol-Version': V, 'Mcp-Method': 'subscriptions/listen'};
      for (const headers of [H, Object.assign({'X-CH-Key': 'not-a-key'}, H)]) {
        const s = await listen(body(70), headers);
        assert.ok(await until(() => s.ended));
        assert.doesNotMatch(String(s.res.headers['content-type']), /event-stream/, JSON.stringify(headers));
        assert.strictEqual(hub.count(null), 0);
        assert.strictEqual(hub.count('not-a-key'), 0);
      }
    });

    it('the per-key rate limit applies to listen', async() => {
      const limited = express();
      limited.use(express.json());
      const cdifStub = {rateLimit: (key, cb) => cb(null, {limited: true})};
      limited.use('/mcp', require('../../lib/routes/mcp')(null, cdifStub, hub));
      const srv = await new Promise((r) => { const x = limited.listen(0, '127.0.0.1', () => r(x)); });
      const data = JSON.stringify(body(90));
      const res = await new Promise((resolve) => {
        const rq = http.request({host: '127.0.0.1', port: srv.address().port, path: '/mcp', method: 'POST',
          headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'MCP-Protocol-Version': V, 'Mcp-Method': 'subscriptions/listen', 'X-CH-Key': KEY}}, (r) => {
          let t = '';
          r.on('data', (c) => { t += c; });
          r.on('end', () => resolve({status: r.statusCode, type: r.headers['content-type'], body: t}));
        });
        rq.end(data);
      });
      await new Promise((r) => srv.close(r));
      assert.doesNotMatch(String(res.type), /event-stream/);
      assert.match(res.body, /rate limit exceeded/);
      assert.strictEqual(hub.count(KEY), 0);
    });

    describe('with a real file-provider key, and a slow provider', () => {
      // --debugKey answers from one string, synchronously; here the auth
      // provider answers, from a real FileAuthProvider over a temporary
      // config, optionally late. The provider in use is patched in the hook
      // and put back after.
      const fs = require('fs');
      const os = require('os');
      const FileAuthProvider = require('../../lib/auth/file-provider');
      const REAL = 'listen-real-file-key';
      let provider;
      let real;
      let delayMs = 0;
      let cfgDir;
      before(() => {
        options.debug = false;
        cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-listen-auth-'));
        const cfg = path.join(cfgDir, 'auth.json');
        fs.writeFileSync(cfg, JSON.stringify({[REAL]: {userName: 'listener', devices: ['*']}}));
        const file = new FileAuthProvider({configPath: cfg});
        provider = require('../../lib/auth').getAuthProvider();
        real = provider.authenticate;
        provider.authenticate = (...args) => {
          const cb = args[args.length - 1];
          const answer = (...r) => (delayMs > 0 ? setTimeout(() => cb(...r), delayMs) : cb(...r));
          file.authenticate(...args.slice(0, -1), answer);
        };
      });
      after(() => {
        provider.authenticate = real;
        options.debug = true;
        delayMs = 0;
        fs.rmSync(cfgDir, {recursive: true, force: true});
      });
      const H = (key) => ({'MCP-Protocol-Version': V, 'Mcp-Method': 'subscriptions/listen', 'X-CH-Key': key});

      it('a valid key gets a stream; an unknown one the error and no stream', async() => {
        const ok = await listen(body(80), H(REAL));
        assert.ok(await until(() => ok.events.length >= 1), ok.raw);
        assert.match(String(ok.res.headers['content-type']), /^text\/event-stream/);
        assert.strictEqual(hub.count(REAL), 1);
        ok.req.destroy();
        assert.ok(await until(() => hub.count(REAL) === 0));
        const bad = await listen(body(81), H('not-a-real-key'));
        assert.ok(await until(() => bad.ended));
        assert.doesNotMatch(String(bad.res.headers['content-type']), /event-stream/);
        assert.strictEqual(hub.count('not-a-real-key'), 0);
      });

      it('a client gone while its key is being checked holds no slot', async() => {
        delayMs = 300;
        const http2 = require('http');
        const data = JSON.stringify(body(82));
        const req = http2.request({host: '127.0.0.1', port, path: '/mcp', method: 'POST',
          headers: Object.assign({'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)}, H(REAL))});
        req.on('error', () => {});
        req.end(data);
        await tick(50);
        req.destroy();
        await tick(600);
        assert.strictEqual(hub.count(REAL), 0, 'no slot held for a gone client');
        delayMs = 0;
      });
    });

    it('a listen that agrees to nothing ends right after its acknowledgement', async() => {
      const s = await listen(body(71, {elicitationsListChanged: true, resourceSubscriptions: []}));
      assert.ok(await until(() => s.ended));
      assert.deepStrictEqual(s.events[0].params.notifications, {});
      assert.strictEqual(s.events[1].result.resultType, 'complete');
      assert.strictEqual(hub.count(KEY), 0);
    });
  });

  // M8: notices now follow a key's own calls, so a listen whose client
  // never reads would hold every one of them. Past what a stream may hold
  // unread, it is closed: the listen is cancelled and its slot freed.
  describe('the /mcp route: a client that never reads', () => {
    const options = require('../../lib/cli-options');
    const KEY = 'listen-unread-key';
    let saved;
    let server;
    let port;
    let opened = null;
    let closed = 0;
    // a hub that hands the test the listen's writer
    const hub = {
      open(o) { opened = o; return {ok: true, close: () => { closed += 1; }}; },
      count: () => 0, endAll() {}, changed() {}, callSucceeded() {}, closeSession() {}
    };
    before((done) => {
      saved = {debug: options.debug, debugKey: options.debugKey};
      options.debug = true;
      options.debugKey = KEY;
      const app = express();
      app.use(express.json());
      app.use('/mcp', require('../../lib/routes/mcp')(null, null, hub, {maxListenBuffered: 64 * 1024}));
      server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
    });
    after((done) => {
      options.debug = saved.debug;
      options.debugKey = saved.debugKey;
      server.closeAllConnections();
      server.close(() => done());
    });

    it('its stream is closed once it holds more than it may unread, cancelling the listen', async() => {
      let clientRes = null;
      const data = JSON.stringify({jsonrpc: '2.0', id: 90, method: 'subscriptions/listen', params: {_meta: META, notifications: {toolsListChanged: true}}});
      const req = http.request({host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data),
          'MCP-Protocol-Version': V, 'Mcp-Method': 'subscriptions/listen', 'X-CH-Key': KEY}}, (res) => {
        clientRes = res;
        res.pause();   // and never read
      });
      req.on('error', () => {});
      req.end(data);
      assert.ok(await until(() => opened != null && clientRes != null));
      // far more than the sockets between them can hold, in notices of 64 KiB
      const big = {jsonrpc: '2.0', method: 'notifications/resources/updated', params: {uri: `countinghouse://m/x/${'y'.repeat(64 * 1024)}`}};
      for (let i = 0; i < 400 && closed === 0; i++) {
        opened.write(big);
        await tick(1);
      }
      assert.ok(await until(() => closed === 1), 'the stream was never closed');
      req.destroy();
    });
  });
});
