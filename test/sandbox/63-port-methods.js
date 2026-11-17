// The runtime's ports are listened on, posted to and closed with
// MessagePort's methods as lib/port-scope.js took them when it loaded, at a
// worker's boot: module code that later replaces MessagePort.prototype's
// postMessage, close or NodeEventTarget's on is never handed a port (a peer
// channel's port arrives after module code has loaded, lib/peer-channel.js).
// The first two cases need no server: the realm is this one, the methods
// replaced and put back.
const assert = require('assert');
const path = require('path');
const {MessageChannel, MessagePort} = require('worker_threads');
const portScope = require('../../lib/port-scope');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {deviceIDForName} = require('../../lib/call-address');

describe('sandbox 63: port methods taken at boot', function() {
  this.timeout(20000);
  // (here no mode is latched: the methods taken at load, as under audit and
  // enforce; under off a worker's posts look postMessage up as the port has
  // it, which composition 18's forge relies on)

  it('postOnPort, onPortMessage, onPortEvent and closePort never call a replaced method', async () => {
    // (made before the methods are replaced: Node's own port set-up calls
    // `this.on` on every new port, which only the lockdown's fixing of
    // these prototypes covers; sandbox 62 checks that)
    const {port1, port2} = new MessageChannel();
    const proto = MessagePort.prototype;
    const eventProto = Object.getPrototypeOf(proto);
    const saved = {post: proto.postMessage, close: proto.close, on: eventProto.on};
    const handed = [];
    proto.postMessage = function(...a) { handed.push(['postMessage', this]); return saved.post.apply(this, a); };
    proto.close = function(...a) { handed.push(['close', this]); return saved.close.apply(this, a); };
    eventProto.on = function(...a) { handed.push(['on', this]); return saved.on.apply(this, a); };
    try {
      const got = new Promise((resolve) => portScope.onPortMessage(port2, (m) => resolve(m)));
      const closed = new Promise((resolve) => portScope.onPortEvent(port2, 'close', () => resolve(true)));
      portScope.postOnPort(port1, {hello: 1});
      assert.deepStrictEqual(await got, {hello: 1});
      portScope.closePort(port1);
      assert.strictEqual(await closed, true);
    } finally {
      proto.postMessage = saved.post;
      proto.close = saved.close;
      eventProto.on = saved.on;
      port1.close();
      port2.close();
    }
    assert.deepStrictEqual(handed.map((h) => h[0]), [], 'a replaced port method was called with a port');
  });

  it('withFields and ownField set and read own data only', () => {
    Object.defineProperty(Object.prototype, 'ch63', {configurable: true, get() { return 'from the prototype'; }, set() { throw new Error('setter ran'); }});
    try {
      const o = portScope.withFields({}, {ch63: 'own'});
      assert.strictEqual(Object.getOwnPropertyDescriptor(o, 'ch63').value, 'own');
      assert.strictEqual(portScope.ownField({}, 'ch63'), undefined);
      assert.strictEqual(portScope.ownField(o, 'ch63'), 'own');
    } finally {
      delete Object.prototype.ch63;
    }
  });
});

// A direct peer channel's port reaches the caller's worker after module code
// has loaded, and Node sets it up then (it calls `this.on` on the new port).
// The caller fixture replaces every method that could be handed it (where
// the lockdown lets it), then makes the worker's first peer call: under
// audit and enforce none of them is handed a port, EventEmitter's included
// (not fixed: a port is not an EventEmitter), and the calls are answered.
// Under off, where nothing is fixed, the replaced NodeEventTarget.on is
// handed the port: the probe sees one when one can be seen.
const KEY = 'port-probe-key';
const AUTH = path.join(__dirname, '63-auth.json');
const CALLEE = path.join(ROOT, 'test', 'fixtures', 'hop-input-callee');
const CALLER = path.join(ROOT, 'test', 'fixtures', 'port-probe-caller');
const FIXED = ['NodeEventTarget.prototype.on', 'NodeEventTarget.prototype.addListener', 'EventTarget.prototype.addEventListener',
  'EventTarget.prototype.dispatchEvent', 'MessagePort.prototype.postMessage', 'MessagePort.prototype.start', 'MessagePort.prototype.close'];
const NOT_FIXED = ['EventEmitter.prototype.on', 'EventEmitter.prototype.addListener', 'EventEmitter.prototype.once', 'EventEmitter.prototype.emit'];

for (const {mode, port} of [{mode: 'enforce', port: testPort(9754)}, {mode: 'audit', port: testPort(9755)}, {mode: 'off', port: testPort(9752)}]) {
  describe(`sandbox 63: a peer channel's port, arriving after module code (${mode})`, function() {
    this.timeout(120000);
    let server = null;
    before(async () => {
      server = await startServer(port, ['--authConfigPath', AUTH, '--loadModule', CALLEE, '--loadModule', CALLER, '--workerThread',
        '--directPeerChannels', '--moduleSandbox', mode]);
    });
    after(() => stopServer(server));

    it(mode === 'off' ? 'a replaced NodeEventTarget.on is handed the port (nothing is fixed)' : 'no replaced method, setter or watched built-in is handed the port or a token, and the calls are answered', async () => {
      const r = await post(port, KEY, `/devices/${deviceIDForName('port-probe-caller')}/invoke-action`,
        {serviceID: 'urn:countinghouse-test:serviceID:probeService', actionName: 'probe', input: {watch: mode !== 'off'}});
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const out = r.body.output;
      const shown = JSON.stringify(out);
      assert.deepStrictEqual(out.calls, ['answered', 'answered'], shown);
      for (const name of NOT_FIXED) assert.strictEqual(out.changed[name], true, `${name} replaced: ${shown}`);
      if (mode === 'off') {
        assert.strictEqual(out.changed['NodeEventTarget.prototype.on'], true, shown);
        assert.ok(out.seen.includes('NodeEventTarget.prototype.on'), `the probe saw the port arrive: ${shown}`);
        return;
      }
      for (const name of FIXED) assert.strictEqual(out.changed[name], false, `${name} is fixed by the lockdown: ${shown}`);
      assert.strictEqual(out.portsSeen, 0, `a port was handed to a replaced method: ${shown}`);
      // nor a call's token, on the peer path: its queue, the channel's
      // pending calls, the callee's metering reply, the envelope's bytes
      assert.strictEqual(out.tokensSeen, 0, `a token was handed to a replaced method or setter: ${shown}`);
      // nor a channel, a query, a client or a device's composition: through
      // a bind module code replaced, or a setter it put on Object.prototype
      // for one of their fields
      assert.strictEqual(out.runtimeSeen, 0, `a runtime object was handed to a replaced bind or a setter: ${shown}`);
    });
  });
}

// What Node itself leaves: it writes the ports a message transferred into an
// array by index, natively, before any JavaScript runs, so a setter module
// code put on Array.prototype's index 0 is handed a peer channel's port as
// it arrives (counted as nativeIndexPorts above, and accepted: an index
// accessor on Array.prototype would change every array's holes). The port
// is worth nothing more than the module's own end of a channel: no token,
// target or input crosses it, and the callee serves an invoke only as the
// main thread's announcement of it says. Under enforce: the module takes
// the port, reads what arrives on it, and posts a replayed invoke (the
// first call's id) and a guessed one while a legitimate hop runs. Neither
// forged invoke is served (the callee ran two sinks, the module's own), each
// is refused on the port, the legitimate hop answers with its own result,
// and no token is seen.
describe('sandbox 63: a peer port module code takes from Node\'s own array (enforce)', function() {
  this.timeout(120000);
  const port = testPort(9756);
  let server = null;
  before(async () => {
    server = await startServer(port, ['--authConfigPath', AUTH, '--loadModule', CALLEE, '--loadModule', CALLER, '--workerThread',
      '--directPeerChannels', '--moduleSandbox', 'enforce']);
  });
  after(() => stopServer(server));

  it('a forged invoke on the taken port is refused unserved; a concurrent hop answers with its own result; no token is seen', async () => {
    const r = await post(port, KEY, `/devices/${deviceIDForName('port-probe-caller')}/invoke-action`,
      {serviceID: 'urn:countinghouse-test:serviceID:probeService', actionName: 'probe', input: {forge: true}});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const out = r.body.output;
    const shown = JSON.stringify(out);
    const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
    // the residual is real: the module holds the port
    assert.strictEqual(out.captured, true, shown);
    assert.deepStrictEqual(out.first, {length: 'ch-sandbox-63-first'.length, sha256: sha('ch-sandbox-63-first')}, shown);
    assert.deepStrictEqual(out.legit, {length: 'ch-sandbox-63-legit'.length, sha256: sha('ch-sandbox-63-legit')}, shown);
    // only the module's own two sinks ran: neither forged invoke was served
    assert.strictEqual(out.runs, 2, shown);
    // each forged invoke refused on the port, with no data
    for (const id of [0, 424242]) {
      const reply = out.read.find((m) => m.id === id && m.category === 'peer-reply');
      assert.ok(reply != null && typeof(reply.errCode) === 'string' && reply.data === null, `invoke ${id} refused on the port: ${shown}`);
    }
    // nothing on the port held a token
    assert.strictEqual(out.tokensSeen, 0, shown);
  });
});
