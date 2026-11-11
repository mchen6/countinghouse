// R2-1's Redis denial, decided on the host as Node will connect to it (the
// code review of #36's second round): an empty host is localhost, a
// numeric literal is the address however it is spelled, and options a
// module inherits are read as Node reads them. Installed directly in a
// worker; each refusal is synchronous, so nothing reaches the network.
const assert = require('assert');
const {inWorker, install} = require('../helpers/lockdown-worker');

// Connects to each [host, port] under the lockdown and returns the code:
// EACCES for a denial, 'not denied' when connect returned.
const attempts = (cfg, targets) => inWorker(`
  ${install(cfg)}
  const net = require('net');
  const codes = {};
  for (const [label, make] of ${targets}) {
    try { const s = net.connect(make()); s.on('error', () => {}); s.destroy(); codes[label] = 'not denied'; }
    catch (e) { codes[label] = String(e.code); }
  }
  return codes;`);

describe('sandbox 37: the Redis denial reads the host as Node does', function() {
  this.timeout(60000);

  it('an empty or false host is localhost', () => {
    const r = attempts({mode: 'audit', denied: {endpoints: [{host: '127.0.0.1', port: 6379}], socketPaths: []}},
      `[['empty', () => ({host: '', port: 6379})], ['false', () => ({host: false, port: 6379})], ['other port', () => ({host: '', port: 1})]]`);
    assert.deepStrictEqual(r, {'empty': 'EACCES', 'false': 'EACCES', 'other port': 'not denied'});
  });

  it('a configured address is denied under every spelling of it', () => {
    const r = attempts({mode: 'audit', denied: {endpoints: [{host: '10.0.0.5', port: 6379}, {host: 'fd00::5', port: 6380}], socketPaths: []}},
      `[['10.5', () => ({host: '10.5', port: 6379})], ['167772165', () => ({host: '167772165', port: 6379})],
        ['0xa.0.0.5', () => ({host: '0xa.0.0.5', port: 6379})], ['fd00:0:0::5', () => ({host: 'fd00:0:0::5', port: 6380})],
        ['FD00::5', () => ({host: 'FD00::5', port: 6380})], ['127.0.0.1:1', () => ({host: '127.0.0.1', port: 1})]]`);
    assert.deepStrictEqual(r, {'10.5': 'EACCES', '167772165': 'EACCES', '0xa.0.0.5': 'EACCES',
      'fd00:0:0::5': 'EACCES', 'FD00::5': 'EACCES', '127.0.0.1:1': 'not denied'});
  });

  it('options inherited through the prototype are read as Node reads them', () => {
    const r = attempts({mode: 'enforce', denied: {endpoints: [{host: '127.0.0.1', port: 6379}], socketPaths: []}},
      `[['inherited endpoint', () => Object.create({host: '127.0.0.1', port: 6379})],
        ['inherited fd', () => Object.create({fd: 999999})]]`);
    assert.deepStrictEqual(r, {'inherited endpoint': 'EACCES', 'inherited fd': 'ERR_ACCESS_DENIED'});
  });
});
