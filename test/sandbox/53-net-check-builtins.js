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

describe('sandbox 53c: the review of #227: the copy helpers, prototype accessors, functions, iterators; addresses added later', function() {
  this.timeout(60000);
  // 127.0.0.2 (the allowed listener) answers on Linux and Windows only
  const it2 = process.platform === 'darwin' ? it.skip : it;
  it2('enforce: none of these reach the denied name; a later denyAddresses catches a connection by address', () => {
    const r = inWorker(`
      const net = require('net');
      const hits = {denied: 0};
      const denied = await new Promise((resolve) => {
        const s = net.createServer((c) => { hits.denied++; c.destroy(); });
        s.listen(0, '127.0.0.1', () => resolve(s));
      });
      const DENIED = denied.address().port;
      // an allowed listener on the same port, on another loopback address:
      // the module's lookup sends the denied name to the denied listener and
      // any other name to this one, so only a host read twice (allowed when
      // checked, denied when used) reaches the denied one
      const allowed = await new Promise((resolve) => {
        const s = net.createServer((c) => { hits.allowed = (hits.allowed || 0) + 1; c.destroy(); });
        s.listen(DENIED, '127.0.0.2', () => resolve(s)).on('error', () => resolve(null));
      });
      const handle = require(${JSON.stringify(LOCKDOWN)}).install({moduleName: 'lockdown-probe', moduleRoot: process.cwd(), mode: 'enforce',
        denied: {endpoints: [{host: ${JSON.stringify(NAME)}, port: DENIED}, {host: '::ffff:10.0.0.5', port: DENIED}], socketPaths: []}}, () => {});
      const outcome = (s) => new Promise((resolve) => {
        s.on('error', (e) => resolve('error ' + e.code));
        s.on('connect', () => { s.destroy(); resolve('connected'); });
      });
      const attempt = (fn) => { try { return outcome(fn()); } catch (e) { return Promise.resolve('threw ' + e.code); } };
      const route = (h) => (h === ${JSON.stringify(NAME)} ? '127.0.0.1' : '127.0.0.2');
      const lookup = (h, o, cb) => (o && o.all ? cb(null, [{address: route(h), family: 4}]) : cb(null, route(h), 4));
      const out = {};
      const swap = async (key, obj, prop, value, fn) => {
        const d = Object.getOwnPropertyDescriptor(obj, prop);
        try {
          try { Object.defineProperty(obj, prop, Object.assign({configurable: true, writable: true}, value)); } catch (e) { out[key] = 'locked'; return; }
          out[key] = await attempt(fn);
        } finally { if (d != null) Object.defineProperty(obj, prop, d); else delete obj[prop]; }
      };
      // a host getter read twice: once by the check, once by Node
      const twice = () => { let n = 0; return {get host() { return n++ === 0 ? 'elsewhere.test' : ${JSON.stringify(NAME)}; }, port: DENIED, lookup}; };
      await swap('weakSetHas', WeakSet.prototype, 'has', {value: () => true}, () => net.connect(twice()));
      await swap('concat', Array.prototype, 'concat', {value: function() { return [twice()]; }}, () => new net.Socket().connect({host: 'elsewhere.test', port: DENIED, lookup}));
      await swap('slice', Array.prototype, 'slice', {value: function() { return [twice()]; }}, () => net.connect({host: 'elsewhere.test', port: DENIED, lookup}));
      await swap('keys', Object, 'keys', {value: () => []}, () => net.connect({host: ${JSON.stringify(NAME)}, port: DENIED, lookup}));
      // an accessor on Object.prototype named host
      let c = 0;
      const protoSwap = async () => {
        const d = Object.getOwnPropertyDescriptor(Object.prototype, 'host');
        try {
          Object.defineProperty(Object.prototype, 'host', {get() { return c++ === 0 ? 'elsewhere.test' : ${JSON.stringify(NAME)}; }, set() {}, enumerable: false, configurable: true});
          out.protoHost = await attempt(() => net.connect({host: ${JSON.stringify(NAME)}, port: DENIED, lookup}));
        } finally { if (d != null) Object.defineProperty(Object.prototype, 'host', d); else delete Object.prototype.host; }
      };
      await protoSwap();
      // an array's iterator, for the mapped IPv4 spelling
      await swap('iterator', Array.prototype, Symbol.iterator, {value: function* () {}}, () => net.connect({host: '::ffff:a00:5', port: DENIED, lookup}));
      // a function as the host: its toPrimitive never runs in the check
      let ran = 0;
      const fnHost = Object.assign(() => {}, {[Symbol.toPrimitive]: () => { ran++; return 'elsewhere.test'; }});
      out.fnHost = await attempt(() => net.connect({host: fnHost, port: DENIED, lookup}));
      out.fnHostRan = ran;
      // by address: allowed until the main thread's later resolution reaches the worker
      out.beforeAdd = await attempt(() => net.connect(DENIED, '127.0.0.1'));
      const before = hits.denied;
      handle.denyAddresses(['127.0.0.1'], DENIED);
      out.afterAdd = await attempt(() => net.connect(DENIED, '127.0.0.1'));
      await new Promise((res) => setTimeout(res, 200));
      out.hitsBefore = before;
      out.hits = hits.denied;
      out.allowedListening = allowed != null;
      denied.close();
      if (allowed != null) allowed.close();
      return out;`);
    const all = JSON.stringify(r);
    // none of them reached the denied listener before the address was added
    // (connected, here, is to the allowed one: the host was read once)
    assert.strictEqual(r.hitsBefore, 1, `only the by-address connect, before the address was added, reached it: ${all}`);
    for (const k of ['keys', 'protoHost', 'iterator']) assert.ok(/^(threw|error) (EACCES|ERR_INVALID_ARG_TYPE)$/.test(String(r[k])), `${k}: ${all}`);
    assert.strictEqual(r.fnHostRan, 0, all);
    assert.match(String(r.fnHost), /^(threw|error) /, all);
    assert.strictEqual(r.beforeAdd, 'connected', 'by address, before the name resolved: the documented residual');
    assert.match(String(r.afterAdd), /^(threw|error) EACCES$/, all);
    assert.strictEqual(r.hits, r.hitsBefore, `nothing reached it once the address was added: ${all}`);
  });
});

describe('sandbox 53d: the refresh (#227 review)', () => {
  const config = require('../../lib/module-sandbox-config');
  afterEach(() => config.resetForTests());

  it('the system resolver and DNS together; a refresh that adds an address tells the listeners; a failure keeps what was known', async () => {
    const r = await config.resolveDenied(`redis://${NAME}:6379`, {lookup: (h, o, cb) => cb(null, [{address: '10.0.0.1', family: 4}]),
      resolve4: (h, cb) => cb(null, ['10.0.0.2', '10.0.0.1']), resolve6: (h, cb) => cb(Object.assign(new Error('x'), {code: 'ENODATA'}))});
    assert.deepStrictEqual(r, {addresses: ['10.0.0.1', '10.0.0.2'], problem: null});
    const told = [];
    config.onDeniedChange((c) => told.push(c));
    let answer = ['10.0.0.1'];
    const opts = {lookup: (h, o, cb) => (answer == null ? cb(Object.assign(new Error('x'), {code: 'ETIMEOUT'})) : cb(null, answer.map((address) => ({address, family: 4}))))};
    await config.refreshDenied(`redis://${NAME}:6379`, opts);
    assert.deepStrictEqual(told, [], 'the first resolution is the workers\' start set');
    answer = ['10.0.0.3'];
    await config.refreshDenied(`redis://${NAME}:6379`, opts);
    assert.deepStrictEqual(told, [{addresses: ['10.0.0.3'], port: 6379}], 'the new one only');
    answer = null;
    const c = await config.refreshDenied(`redis://${NAME}:6379`, opts);
    assert.deepStrictEqual([c.addresses, c.problem], [['10.0.0.1', '10.0.0.3'], 'ETIMEOUT']);
    assert.deepStrictEqual(config.deniedEndpoints(`redis://${NAME}:6379`).endpoints.map((e) => e.host), [NAME, '10.0.0.1', '10.0.0.3']);
  });
});

describe('sandbox 53e: the security review of #227 (Object.prototype pollution, a hijacked Map, IDNA, inherited options)', function() {
  this.timeout(60000);
  it('enforce: none of these reach the denied endpoint (run on the floor Node too: 22.23.4 and 24.15.0 read SocketAddress fields through Object.prototype)', () => {
    const r = inWorker(`
      const net = require('net');
      const hits = {denied: 0};
      const denied = await new Promise((resolve) => {
        const s = net.createServer((c) => { hits.denied++; c.destroy(); });
        s.listen(0, '127.0.0.1', () => resolve(s));
      });
      const DENIED = denied.address().port;
      const outcome = (s) => new Promise((resolve) => {
        s.on('error', (e) => resolve('error ' + e.code));
        s.on('connect', () => { s.destroy(); resolve('connected'); });
      });
      const attempt = (fn) => { try { return outcome(fn()); } catch (e) { return Promise.resolve('threw ' + e.code); } };
      const out = {};
      // the denied endpoint by its loopback address, and the name (its
      // address to come later, by denyAddresses)
      const handle = require(${JSON.stringify(LOCKDOWN)}).install({moduleName: 'lockdown-probe', moduleRoot: process.cwd(), mode: 'enforce',
        denied: {endpoints: [{host: '127.0.0.1', port: DENIED}, {host: ${JSON.stringify(NAME)}, port: DENIED + 1}, {host: ${JSON.stringify(NAME)}, port: DENIED + 2}], socketPaths: []}}, () => {});
      // 1. Object.prototype.flowlabel and .port polluted: the handle's check
      // must still match (it used to throw inside and answer false)
      Object.prototype.flowlabel = -1;
      Object.prototype.port = -1;
      try {
        out.polluted = await attempt(() => net.connect(DENIED, '127.0.0.1'));
        // the handle's check alone: a name the net-level check allows, which
        // the module's own lookup sends to the denied address
        out.pollutedViaLookup = await attempt(() => net.connect({host: 'harmless.test', port: DENIED,
          lookup: (h, o, cb) => (o && o.all ? cb(null, [{address: '127.0.0.1', family: 4}]) : cb(null, '127.0.0.1', 4))}));
        // 3. an address added while polluted: added (or the port denied whole),
        // never a throw that leaves it unadded
        try { handle.denyAddresses(['127.0.0.1'], DENIED + 1); } catch (e) { out.addThrew = e.message; }
      } finally { delete Object.prototype.flowlabel; delete Object.prototype.port; }
      // the name's port, by address, after the polluted add
      const second = await new Promise((resolve) => {
        const s = net.createServer((c) => { hits.denied++; c.destroy(); });
        s.listen(DENIED + 1, '127.0.0.1', () => resolve(s)).on('error', () => resolve(null));
      });
      out.addedWhilePolluted = second != null ? await attempt(() => net.connect(DENIED + 1, '127.0.0.1')) : 'no port';
      // 2. a Map.prototype.set that would capture the guard's map: nothing
      // is set at call time, so nothing is captured
      let captured = null;
      const mapSet = Map.prototype.set;
      Map.prototype.set = function(k, v) { if (k === DENIED + 1) captured = this; return mapSet.call(this, k, v); };
      try { handle.denyAddresses(['127.0.0.1'], DENIED + 1); } finally { Map.prototype.set = mapSet; }
      if (captured != null) captured.delete(DENIED + 1);
      out.mapCaptured = captured != null;
      out.afterMap = second != null ? await attempt(() => net.connect(DENIED + 1, '127.0.0.1')) : 'no port';
      // 5a. an inherited host (no own one): read once, and the connect uses it
      const route = (h) => (h === ${JSON.stringify(NAME)} ? '127.0.0.1' : '127.0.0.9');
      const lookup = (h, o, cb) => (o && o.all ? cb(null, [{address: route(h), family: 4}]) : cb(null, route(h), 4));
      let n = 0;
      Object.defineProperty(Object.prototype, 'host', {configurable: true, get() { return n++ === 0 ? 'elsewhere.test' : ${JSON.stringify(NAME)}; }});
      try { out.inherited = await attempt(() => net.connect({port: DENIED + 1, lookup})); } finally { delete Object.prototype.host; }
      // The name check alone: a port denied by the name only (no address
      // added), the module's lookup sending the name to 127.0.0.2 there
      const third = await new Promise((resolve) => {
        const s = net.createServer((c) => { hits.denied++; c.destroy(); });
        s.listen(DENIED + 2, '127.0.0.2', () => resolve(s)).on('error', () => resolve(null));
      });
      // (by name: the denied name to the listener, any other, localhost
      // included, nowhere: only a host read twice reaches it)
      const second2 = (h) => (h === ${JSON.stringify(NAME)} ? '127.0.0.2' : '127.0.0.9');
      const toSecondLoopback = (h, o, cb) => (o && o.all ? cb(null, [{address: second2(h), family: 4}]) : cb(null, second2(h), 4));
      // 5a'. an inherited host that answers the check with undefined (so it
      // sees localhost), then the denied name
      let u = 0;
      Object.defineProperty(Object.prototype, 'host', {configurable: true, get() { return u++ === 0 ? undefined : ${JSON.stringify(NAME)}; }});
      try { out.inheritedUndefined = third != null ? await attempt(() => net.connect({port: DENIED + 2, lookup: toSecondLoopback})) : 'no port'; } finally { delete Object.prototype.host; }
      // 5a''. an own denied host with an inherited port that answers
      // undefined first, then the denied port
      let p = 0;
      Object.defineProperty(Object.prototype, 'port', {configurable: true, get() { return p++ === 0 ? undefined : DENIED + 2; }});
      try { out.inheritedPort = third != null ? await attempt(() => net.connect({host: ${JSON.stringify(NAME)}, lookup: toSecondLoopback})) : 'no port'; } finally { delete Object.prototype.port; }
      if (third != null) third.close();
      // 5b. a fullwidth spelling Node's lookup maps to the name
      out.fullwidth = await attempt(() => net.connect({host: '\\uff52edis-denied.test', port: DENIED + 1, lookup}));
      await new Promise((res) => setTimeout(res, 200));
      out.hits = hits.denied;
      denied.close();
      if (second != null) second.close();
      return out;`);
    const all = JSON.stringify(r);
    assert.strictEqual(r.hits, 0, `a connection reached the denied endpoint: ${all}`);
    for (const k of ['polluted', 'pollutedViaLookup', 'addedWhilePolluted', 'afterMap', 'fullwidth']) {
      assert.ok(/^(threw|error) EACCES$/.test(String(r[k])) || r[k] === 'no port', `${k}: ${all}`);
    }
    assert.strictEqual(r.mapCaptured, false, all);
    assert.strictEqual(r.addThrew, undefined, all);
  });
});

describe('sandbox 53f: every lockdown worker is told the addresses (#227 review)', () => {
  const config = require('../../lib/module-sandbox-config');
  afterEach(() => config.resetForTests());
  it('a worker tracked after a refresh is told what is known at once; a later refresh sends only the new ones; an ended one is not told', async () => {
    const url = `redis://${NAME}:6379`;
    let answer = ['10.0.0.1'];
    const opts = {lookup: (h, o, cb) => cb(null, answer.map((address) => ({address, family: 4})))};
    await config.refreshDenied(url, opts);
    const events = new (require('events').EventEmitter)();
    const sent = [];
    const wm = {sendMessageToWorker: (m) => sent.push(m)};
    config.trackWorker(wm, events, url);
    assert.deepStrictEqual(sent, [{command: 'denied-addresses', addresses: ['10.0.0.1'], port: 6379}]);
    answer = ['10.0.0.1', '10.0.0.2'];
    await config.refreshDenied(url, opts);
    assert.deepStrictEqual(sent[1], {command: 'denied-addresses', addresses: ['10.0.0.2'], port: 6379}, 'only the new one');
    events.emit('exit');
    answer = ['10.0.0.3'];
    await config.refreshDenied(url, opts);
    assert.strictEqual(sent.length, 2, 'an ended worker is not told');
  });
  it('at most 64 addresses are known for the name', async () => {
    const url = `redis://${NAME}:6379`;
    const many = Array.from({length: 100}, (_, i) => `10.1.${Math.floor(i / 250)}.${(i % 250) + 1}`);
    const c = await config.refreshDenied(url, {lookup: (h, o, cb) => cb(null, many.map((address) => ({address, family: 4})))});
    assert.strictEqual(c.addresses.length, 64);
  });
});
