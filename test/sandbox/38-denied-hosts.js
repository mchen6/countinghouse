// R2-1's Redis denial, decided on the endpoint as Node will connect to it
// (the code review of #36): an empty host is localhost, a numeric literal
// is the address however it is spelled, and a string first argument is a
// port whenever Node reads it as one. Installed directly in a worker; each
// refusal is synchronous, so nothing reaches the network.
const assert = require('assert');
const {inWorker, install} = require('../helpers/lockdown-worker');

// Runs each [label, make] under the lockdown and returns the code: EACCES
// for a denial, 'not denied' when make returned a socket.
const attempts = (cfg, targets) => inWorker(`
  ${install(cfg)}
  const net = require('net');
  const codes = {};
  for (const [label, make] of ${targets}) {
    try { const s = make(); s.on('error', () => {}); s.destroy(); codes[label] = 'not denied'; }
    catch (e) { codes[label] = String(e.code); }
  }
  return codes;`);

describe('sandbox 38: the Redis denial reads the host as Node does', function() {
  this.timeout(60000);

  it('an empty or false host is localhost', () => {
    const r = attempts({mode: 'audit', denied: {endpoints: [{host: '127.0.0.1', port: 6379}], socketPaths: []}},
      `[['empty', () => net.connect({host: '', port: 6379})], ['false', () => net.connect({host: false, port: 6379})], ['other port', () => net.connect({host: '', port: 1})]]`);
    assert.deepStrictEqual(r, {'empty': 'EACCES', 'false': 'EACCES', 'other port': 'not denied'});
  });

  it('a configured address is denied under every spelling of it', () => {
    const r = attempts({mode: 'audit', denied: {endpoints: [{host: '10.0.0.5', port: 6379}, {host: 'fd00::5', port: 6380}], socketPaths: []}},
      `[['10.5', () => net.connect({host: '10.5', port: 6379})], ['167772165', () => net.connect({host: '167772165', port: 6379})],
        ['0xa.0.0.5', () => net.connect({host: '0xa.0.0.5', port: 6379})], ['fd00:0:0::5', () => net.connect({host: 'fd00:0:0::5', port: 6380})],
        ['FD00::5', () => net.connect({host: 'FD00::5', port: 6380})], ['127.0.0.1:1', () => net.connect({host: '127.0.0.1', port: 1})]]`);
    assert.deepStrictEqual(r, {'10.5': 'EACCES', '167772165': 'EACCES', '0xa.0.0.5': 'EACCES',
      'fd00:0:0::5': 'EACCES', 'FD00::5': 'EACCES', '127.0.0.1:1': 'not denied'});
  });

  // An IPv4-mapped or IPv4-compatible IPv6 literal is its IPv4 address,
  // on either side (code review of round 3).
  it('an IPv4 address is denied under its IPv6 forms, and the other way round', () => {
    const r = attempts({mode: 'audit', denied: {endpoints: [{host: '10.0.0.5', port: 6379}, {host: '::ffff:10.0.0.6', port: 6379}], socketPaths: []}},
      `[['::ffff:10.0.0.5', () => net.connect({host: '::ffff:10.0.0.5', port: 6379})], ['::ffff:a00:5', () => net.connect({host: '::ffff:a00:5', port: 6379})],
        ['::10.0.0.5', () => net.connect({host: '::10.0.0.5', port: 6379})], ['10.0.0.6', () => net.connect({host: '10.0.0.6', port: 6379})],
        ['::ffff:10.0.0.7', () => net.connect({host: '::ffff:10.0.0.7', port: 6379})]]`);
    assert.deepStrictEqual(r, {'::ffff:10.0.0.5': 'EACCES', '::ffff:a00:5': 'EACCES', '::10.0.0.5': 'EACCES',
      '10.0.0.6': 'EACCES', '::ffff:10.0.0.7': 'not denied'});
  });

  it('a loopback Redis is denied under the IPv4-compatible loopback forms', () => {
    const r = attempts({mode: 'audit', denied: {endpoints: [{host: '127.0.0.1', port: 6379}], socketPaths: []}},
      `[['::127.0.0.1', () => net.connect({host: '::127.0.0.1', port: 6379})], ['::7f00:2', () => net.connect({host: '::7f00:2', port: 6379})]]`);
    assert.deepStrictEqual(r, {'::127.0.0.1': 'EACCES', '::7f00:2': 'EACCES'});
  });

  // A relative path is read from the process's directory, as the connect
  // reads it; the worker here has its real one.
  it('a denied socket path is denied under every spelling of it', () => {
    const rel = `${process.cwd()}/ch-38-rel.sock`;
    const r = attempts({mode: 'audit', denied: {endpoints: [], socketPaths: ['/run/ch-38/redis.sock', rel]}},
      `[['..', () => net.connect({path: '/run/ch-38/../ch-38/redis.sock'})], ['//', () => net.connect('/run//ch-38/redis.sock')],
        ['./', () => net.connect({path: '/run/ch-38/./redis.sock'})], ['relative', () => net.connect('ch-38-rel.sock')],
        ['other', () => net.connect('/run/ch-38/other.sock')]]`);
    assert.deepStrictEqual(r, {'..': 'EACCES', '//': 'EACCES', './': 'EACCES', 'relative': 'EACCES', 'other': 'not denied'});
  });

  // Node reads a string as a pipe path only when Number(s) >= 0 is false;
  // a raw Socket's connect gets the arguments as the module wrote them.
  it('a string port is a port whenever Node reads it as one', () => {
    const r = attempts({mode: 'audit', denied: {endpoints: [{host: '127.0.0.1', port: 6379}], socketPaths: []}},
      `[['0x18eb', () => new net.Socket().connect('0x18eb', '127.0.0.1')], [' 6379', () => new net.Socket().connect(' 6379', '127.0.0.1')],
        ['6.379e3', () => new net.Socket().connect('6.379e3', '127.0.0.1')], ['6379', () => new net.Socket().connect('6379', '127.0.0.1')],
        ['a pipe path', () => new net.Socket().connect('/nonexistent/ch-38.sock')]]`);
    assert.deepStrictEqual(r, {'0x18eb': 'EACCES', ' 6379': 'EACCES', '6.379e3': 'EACCES', '6379': 'EACCES', 'a pipe path': 'not denied'});
  });
});
