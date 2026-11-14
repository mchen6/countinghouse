'use strict';
// The native handle prototypes' connect and connect6 (found reviewing #177):
// module code took the TCP prototype from a socket's _handle, wrapped
// connect(req, address, port) to swap the port for a denied endpoint's, and
// net.connect to an allowed port then passed the Redis check and reached
// the denied one. Pipe's connect had the same gap for denied socket paths.
// They are locked, and check the destination themselves, in audit and
// enforce alike (the Redis denial is R2-1's, under both).
const assert = require('assert');
const {inWorker, LOCKDOWN} = require('../helpers/lockdown-worker');

const WIN = process.platform === 'win32';
// a socket path a test may listen on, as the worker builds it
const sockPath = (name) => (WIN ? `'\\\\\\\\.\\\\pipe\\\\${name}-' + process.pid` : `require('path').join(require('os').tmpdir(), '${name}-' + process.pid + '.sock')`);

describe('sandbox 51: the handle prototypes\' connect checks the destination itself', function() {
  this.timeout(60000);

  ['audit', 'enforce'].forEach((mode) => {
    it(`${mode}: a rewritten connect, or a handle's own prototype calling it, reaches no denied endpoint or socket path`, () => {
      const r = inWorker(`
        const net = require('net');
        // A denied endpoint and an allowed one, both ours, on loopback, and a
        // denied socket path: which one accepted a connection says where it went.
        const hits = {denied: 0, allowed: 0, deniedPipe: 0};
        const listen = (at, key) => new Promise((resolve) => {
          const s = net.createServer((c) => { hits[key]++; c.destroy(); });
          s.listen(...at, () => resolve(s));
        });
        const denied = await listen([0, '127.0.0.1'], 'denied');
        const allowed = await listen([0, '127.0.0.1'], 'allowed');
        const pipePath = ${sockPath('ch-51-denied')};
        const deniedPipe = await listen([pipePath], 'deniedPipe');
        const DENIED = denied.address().port;
        const ALLOWED = allowed.address().port;
        const reports = [];
        require(${JSON.stringify(LOCKDOWN)}).install({moduleName: 'lockdown-probe', moduleRoot: process.cwd(), mode: ${JSON.stringify(mode)},
          denied: {endpoints: [{host: '127.0.0.1', port: DENIED}], socketPaths: [pipePath]}}, (rule, target) => reports.push(rule + ' ' + target));
        const out = {};
        const outcome = (s) => new Promise((resolve) => {
          s.on('error', (e) => resolve('error ' + e.code));
          s.on('connect', () => { s.destroy(); resolve('connected'); });
        });
        const attempt = (fn) => { try { return outcome(fn()); } catch (e) { return Promise.resolve('threw ' + e.code); } };

        // the TCP prototype, from a socket's own handle
        const s0 = net.connect(ALLOWED, '127.0.0.1');
        await outcome(s0);
        const s0b = net.connect(ALLOWED, '127.0.0.1');
        const tcp = Object.getPrototypeOf(s0b._handle);
        s0b.on('error', () => {}); s0b.destroy();
        const td = Object.getOwnPropertyDescriptor(tcp, 'connect');
        out.tcpLocked = td != null && td.writable === false && td.configurable === false;
        const td6 = Object.getOwnPropertyDescriptor(tcp, 'connect6');
        out.tcp6Locked = td6 == null || (td6.writable === false && td6.configurable === false);
        // 1. the prototype's connect rewritten to swap the port
        const orig = tcp.connect;
        try { tcp.connect = function(req, addr, port) { return orig.call(this, req, addr, DENIED); }; } catch (e) { /* locked */ }
        try { Object.defineProperty(tcp, 'connect', {value: function(req, addr, port) { return orig.call(this, req, addr, DENIED); }}); } catch (e) { /* locked */ }
        out.rewrite = await attempt(() => net.connect(ALLOWED, '127.0.0.1'));
        // 2. a handle given a prototype of its own whose connect calls the
        // original with the denied port
        // (the socket first: lookup is called while connect runs)
        const s1 = new net.Socket();
        s1.connect({port: ALLOWED, host: 'localhost', family: 4, lookup: (h, o, cb) => {
          try {
            const mine = Object.create(tcp);
            Object.defineProperty(mine, 'connect', {value: function(req, addr) { return tcp.connect.call(this, req, addr, DENIED); }});
            Object.setPrototypeOf(s1._handle, mine);
            out.ownProtoSet = true;
          } catch (e) { out.ownProtoSet = 'threw ' + (e.code || e.message); }
          cb(null, '127.0.0.1', 4);
        }});
        out.ownProto = await outcome(s1);
        // 3. the Pipe prototype's connect rewritten toward the denied socket path
        const p0 = net.connect(${sockPath('ch-51-none')});
        const pipe = p0._handle != null ? Object.getPrototypeOf(p0._handle) : null;
        p0.on('error', () => {}); p0.destroy();
        const pd = pipe != null ? Object.getOwnPropertyDescriptor(pipe, 'connect') : null;
        out.pipeLocked = pd != null && pd.writable === false && pd.configurable === false;
        if (pipe != null) {
          const porig = pipe.connect;
          try { pipe.connect = function(req, addr, ...rest) { return porig.call(this, req, pipePath, ...rest); }; } catch (e) { /* locked */ }
        }
        out.pipeRewrite = await attempt(() => net.connect(${sockPath('ch-51-other')}));
        await new Promise((res) => setTimeout(res, 200));
        out.hits = hits;
        out.redisReports = reports.filter((l) => l.startsWith('redis '));
        for (const s of [denied, allowed, deniedPipe]) s.close();
        return out;`);
      const all = JSON.stringify(r);
      assert.strictEqual(r.tcpLocked, true, all);
      assert.strictEqual(r.tcp6Locked, true, all);
      assert.strictEqual(r.pipeLocked, true, all);
      assert.strictEqual(r.hits.denied, 0, `a connection reached the denied endpoint: ${all}`);
      assert.strictEqual(r.hits.deniedPipe, 0, `a connection reached the denied socket path: ${all}`);
      // the rewrite did not take: the connect went where it was asked to
      assert.strictEqual(r.rewrite, 'connected', all);
      // a handle's own prototype calling the original toward the denied port: refused there, and said
      assert.strictEqual(r.ownProtoSet, true, all);
      assert.strictEqual(r.ownProto, 'error EACCES', all);
      assert.ok(r.redisReports.length > 0, all);
    });
  });
});
