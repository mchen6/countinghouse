// L1, review of #36: each guarded entry point reads its arguments as Node
// will, once. An options object is copied by its own enumerable properties,
// as Node's Socket constructor reads them, so an inherited property is
// dropped; an array that is not Node's normalised [options, cb] is read as
// Node reads it, as an object of its own properties. Installed directly in
// a worker; each refusal is synchronous, so nothing reaches the network.
const assert = require('assert');
const {inWorker, install} = require('../helpers/lockdown-worker');

const REDIS = {endpoints: [{host: '127.0.0.1', port: 6379}], socketPaths: []};

// Runs each [label, make] under the lockdown: EACCES or another code when
// make throws, 'not denied' when it returns a socket.
const attempts = (cfg, targets) => inWorker(`
  ${install(cfg)}
  const net = require('net');
  const codes = {};
  for (const [label, make] of ${targets}) {
    try { const s = make(); s.on('error', () => {}); s.destroy(); codes[label] = 'not denied'; }
    catch (e) { codes[label] = String(e.code); }
  }
  return {codes, reports};`);

describe('sandbox 37: the lockdown reads arguments as Node does', function() {
  this.timeout(60000);

  it('an array that is not Node\'s normalised arguments is read by its own properties', () => {
    const r = attempts({mode: 'audit', denied: REDIS},
      `[['Socket.connect', () => new net.Socket().connect(Object.assign([], {host: '127.0.0.1', port: 6379}))],
        ['net.connect', () => net.connect(Object.assign([], {host: '127.0.0.1', port: 6379}))],
        ['net.connect, normalised by Node', () => net.connect({host: '127.0.0.1', port: 1})]]`);
    assert.deepStrictEqual(r.codes, {'Socket.connect': 'EACCES', 'net.connect': 'EACCES', 'net.connect, normalised by Node': 'not denied'});
  });

  it('an inherited option is dropped: no endpoint, no descriptor, no violation', () => {
    const r = attempts({mode: 'enforce', denied: REDIS},
      `[['inherited endpoint', () => new net.Socket().connect(Object.create({host: '127.0.0.1', port: 6379}))],
        ['inherited fd', () => new net.Socket(Object.create({fd: 999999}))]]`);
    // Node's own answer to connect() with no port or path.
    assert.deepStrictEqual(r.codes, {'inherited endpoint': 'ERR_MISSING_ARGS', 'inherited fd': 'not denied'});
    assert.deepStrictEqual(r.reports.filter((l) => /^(descriptor|redis) /.test(l)), [], JSON.stringify(r.reports));
  });

  it('the worker helper reports a worker that ends without an answer', () => {
    assert.throws(() => inWorker('process.exit(2);'), /worker exited with code 2/);
  });
});
