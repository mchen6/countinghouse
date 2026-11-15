'use strict';
// #207: the net-level Redis check (net.Socket.prototype.connect ->
// refuseDenied -> deniedTarget -> canonicalHost in lib/module-lockdown.js)
// called built-ins at call time. Module code that replaced one could make the
// check see another host than the one the connection uses, and for a denied
// endpoint given by a name (not loopback, so not in the handle's BlockList,
// #206) only that check stood. So:
// - the check calls only what it took at load (as the handle guards do), and
//   the host it checked is the host the connection is given;
// - the denied name's addresses, resolved by the main thread before the
//   worker starts, are in the handle's BlockList too, so connecting to the
//   name's address directly (resolved by the module itself) is refused there.
const assert = require('assert');
const {inWorker, LOCKDOWN} = require('../helpers/lockdown-worker');

const NAME = 'redis-denied.test';

describe('sandbox 53: the net-level Redis check calls nothing a module can replace (#207)', function() {
  this.timeout(60000);

  ['audit', 'enforce'].forEach((mode) => {
    it(`${mode}: a denied endpoint given by a name stays denied whatever built-in is replaced`, () => {
      const r = inWorker(`
        const net = require('net');
        const hits = {denied: 0};
        const denied = await new Promise((resolve) => {
          const s = net.createServer((c) => { hits.denied++; c.destroy(); });
          s.listen(0, '127.0.0.1', () => resolve(s));
        });
        const DENIED = denied.address().port;
        const allowed = await new Promise((resolve) => {
          const s = net.createServer((c) => { hits.allowed = (hits.allowed || 0) + 1; c.destroy(); });
          s.listen(0, '127.0.0.1', () => resolve(s));
        });
        const ALLOWED = allowed.address().port;
        const reports = [];
        // the denied endpoint by its name alone: only the net-level check
        // stands for it (its addresses are 53a's)
        require(${JSON.stringify(LOCKDOWN)}).install({moduleName: 'lockdown-probe', moduleRoot: process.cwd(), mode: ${JSON.stringify(mode)},
          denied: {endpoints: [{host: ${JSON.stringify(NAME)}, port: DENIED}], socketPaths: []}},
          (rule, target) => reports.push(rule + ' ' + target));
        const outcome = (s) => new Promise((resolve) => {
          s.on('error', (e) => resolve('error ' + e.code));
          s.on('connect', () => { s.destroy(); resolve('connected'); });
        });
        const attempt = (fn) => { try { return outcome(fn()); } catch (e) { return Promise.resolve('threw ' + e.code); } };
        // the name reaches our listener through the module's own lookup
        const viaName = () => net.connect({host: ${JSON.stringify(NAME)}, port: DENIED, lookup: (h, o, cb) => (o && o.all ? cb(null, [{address: '127.0.0.1', family: 4}]) : cb(null, '127.0.0.1', 4))});
        const out = {};
        out.plain = await attempt(viaName);
        // each built-in the check used at call time, replaced in turn
        const swaps = {
          toLowerCase: [String.prototype, 'toLowerCase', (orig) => function() { return this === ${JSON.stringify(NAME)} || String(this) === ${JSON.stringify(NAME)} ? 'elsewhere.test' : orig.call(this); }],
          replace: [String.prototype, 'replace', () => function() { return 'elsewhere.test'; }],
          startsWith: [String.prototype, 'startsWith', () => function() { return false; }],
          endsWith: [String.prototype, 'endsWith', () => function() { return true; }],
          slice: [String.prototype, 'slice', () => function() { return 'elsewhere.test'; }],
          exec: [RegExp.prototype, 'exec', () => function() { return null; }],
          some: [Array.prototype, 'some', () => function() { return false; }],
          isIPv4: [net, 'isIPv4', () => function() { return false; }],
          isIPv6: [net, 'isIPv6', () => function() { return false; }],
          Number: [globalThis, 'Number', () => function() { return -1; }],
          String: [globalThis, 'String', () => function() { return 'elsewhere.test'; }],
          URL: [globalThis, 'URL', () => function() { return {hostname: 'elsewhere.test'}; }]
        };
        for (const [key, [obj, prop, make]] of Object.entries(swaps)) {
          const orig = obj[prop];
          try {
            try { obj[prop] = make(orig); } catch (e) { out[key] = 'locked'; continue; }
            out[key] = await attempt(viaName);
          } finally {
            try { obj[prop] = orig; } catch (e) { /* locked */ }
          }
        }
        // Function.prototype.apply: the wrapper hands the checked arguments on
        // with what it took at load, never apply at call time
        const savedApply = Function.prototype.apply;
        // (Node hands the wrapper its normalised [options, cb]: the hook
        // rewrites that, after the check, toward the denied name and port)
        Function.prototype.apply = function(thisArg, args) {
          const first = Array.isArray(args) ? args[0] : null;
          const opts = Array.isArray(first) ? first[0] : first;
          if (thisArg instanceof net.Socket && opts != null && typeof(opts) === 'object' && opts.host === 'allowed.test') {
            opts.host = ${JSON.stringify(NAME)};
            opts.port = DENIED;
          }
          return Reflect.apply(this, thisArg, args == null ? [] : args);
        };
        try {
          out.apply = await attempt(() => net.connect({host: 'allowed.test', port: ALLOWED, lookup: (h, o, cb) => (o && o.all ? cb(null, [{address: '127.0.0.1', family: 4}]) : cb(null, '127.0.0.1', 4))}));
        } finally { Function.prototype.apply = savedApply; }
        // a host that reads one way when checked and another when used: never
        // read by the check, and Node refuses a host that is not a string
        let reads = 0;
        const shifty = {toString: () => (reads++ === 0 ? 'elsewhere.test' : ${JSON.stringify(NAME)})};
        out.shiftyHost = await attempt(() => net.connect({host: shifty, port: DENIED, lookup: (h, o, cb) => (o && o.all ? cb(null, [{address: '127.0.0.1', family: 4}]) : cb(null, '127.0.0.1', 4))}));
        out.shiftyReads = reads;
        await new Promise((res) => setTimeout(res, 200));
        out.hits = hits;
        out.reports = reports.filter((l) => l.startsWith('redis '));
        denied.close();
        allowed.close();
        return out;`);
      const all = JSON.stringify(r);
      assert.strictEqual(r.hits.denied, 0, `a connection reached the denied endpoint: ${all}`);
      // the wrapper never calls apply: the connect went where it was asked to
      assert.strictEqual(r.apply, 'connected', all);
      for (const key of ['plain', 'toLowerCase', 'replace', 'startsWith', 'endsWith', 'slice', 'exec', 'some', 'isIPv4', 'isIPv6', 'Number', 'String', 'URL']) {
        assert.ok(/^(threw|error) EACCES$/.test(String(r[key])) || r[key] === 'locked', `${key}: ${r[key]} (${all})`);
      }
      assert.match(String(r.shiftyHost), /^(threw|error) ERR_INVALID_ARG_TYPE$/, all);
      assert.strictEqual(r.shiftyReads, 0, 'the check never called the module\'s toString');
      assert.ok(r.reports.length > 0, all);
    });
  });
});

describe('sandbox 53a: a denied name with several addresses (#207)', function() {
  this.timeout(60000);
  // 127.0.0.2 and .3 answer on Linux and Windows; macOS has only 127.0.0.1
  // without an alias
  const it2 = process.platform === 'darwin' ? it.skip : it;
  it2('the name resolved to two addresses (all: true): a connection to each, by address, is refused at the handle', async () => {
    const config = require('../../lib/module-sandbox-config');
    const lookup = (host, opts, cb) => cb(null, [{address: '127.0.0.2', family: 4}, {address: '127.0.0.3', family: 4}]);
    const resolved = await config.resolveDenied(`redis://${NAME}:6379`, {lookup});
    const r = inWorker(`
      const net = require('net');
      const hits = {a: 0, b: 0};
      const listen = (host, key) => new Promise((resolve) => {
        const s = net.createServer((c) => { hits[key]++; c.destroy(); });
        s.listen(0, host, () => resolve(s));
      });
      const a = await listen('127.0.0.2', 'a');
      // the same port on the second address
      const PORT = a.address().port;
      const b = await new Promise((resolve) => { const s = net.createServer((c) => { hits.b++; c.destroy(); }); s.listen(PORT, '127.0.0.3', () => resolve(s)); });
      const endpoints = ${JSON.stringify(resolved.addresses)}.map((h) => ({host: h, port: PORT}));
      require(${JSON.stringify(LOCKDOWN)}).install({moduleName: 'lockdown-probe', moduleRoot: process.cwd(), mode: 'enforce',
        denied: {endpoints: [{host: ${JSON.stringify(NAME)}, port: PORT}].concat(endpoints), socketPaths: []}}, () => {});
      const outcome = (s) => new Promise((resolve) => {
        s.on('error', (e) => resolve('error ' + e.code));
        s.on('connect', () => { s.destroy(); resolve('connected'); });
      });
      const attempt = (fn) => { try { return outcome(fn()); } catch (e) { return Promise.resolve('threw ' + e.code); } };
      // by address, through a lookup that hides it from the name check
      const via = (address) => () => net.connect({host: 'elsewhere.test', port: PORT, lookup: (h, o, cb) => (o && o.all ? cb(null, [{address, family: 4}]) : cb(null, address, 4))});
      const out = {a: await attempt(via('127.0.0.2')), b: await attempt(via('127.0.0.3')), aDirect: await attempt(() => net.connect(PORT, '127.0.0.2'))};
      await new Promise((res) => setTimeout(res, 200));
      out.hits = hits;
      a.close(); b.close();
      return out;`);
    const all = JSON.stringify(r);
    assert.deepStrictEqual(r.hits, {a: 0, b: 0}, all);
    for (const k of ['a', 'b', 'aDirect']) assert.ok(/^(threw|error) EACCES$/.test(String(r[k])), `${k}: ${all}`);
  });
});

describe('sandbox 53b: the denied endpoint\'s names resolved by the main thread (#207)', () => {
  const config = require('../../lib/module-sandbox-config');

  it('a name\'s addresses join the denied endpoints, as literal addresses the handle blocks; a literal or a socket path is unchanged', async () => {
    const lookup = (host, opts, cb) => cb(null, host === NAME ? [{address: '10.9.8.7', family: 4}, {address: 'fd00::7', family: 6}] : []);
    const resolved = await config.resolveDenied(`redis://${NAME}:6380`, {lookup});
    assert.deepStrictEqual(config.deniedEndpoints(`redis://${NAME}:6380`, resolved).endpoints,
      [{host: NAME, port: 6380}, {host: '10.9.8.7', port: 6380}, {host: 'fd00::7', port: 6380}]);
    assert.deepStrictEqual(config.deniedEndpoints('redis://127.0.0.1:6379', await config.resolveDenied('redis://127.0.0.1:6379', {lookup})).endpoints, [{host: '127.0.0.1', port: 6379}]);
    assert.deepStrictEqual(config.deniedEndpoints('unix:///run/redis.sock', null), {endpoints: [], socketPaths: ['/run/redis.sock']});
  });

  it('a name that cannot be resolved denies the name still, and says so', async () => {
    const lookup = (host, opts, cb) => cb(Object.assign(new Error('nope'), {code: 'ENOTFOUND'}));
    const resolved = await config.resolveDenied(`redis://${NAME}:6379`, {lookup});
    assert.deepStrictEqual(resolved, {addresses: [], problem: 'ENOTFOUND'});
    assert.deepStrictEqual(config.deniedEndpoints(`redis://${NAME}:6379`, resolved).endpoints, [{host: NAME, port: 6379}]);
  });
});
