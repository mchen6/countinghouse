// Pure cover for lib/call-address.js: no server, no Redis, no worker.
// The UUID assertion is the load-bearing one -- if this file's derivation
// ever drifts from CHDevice's, every address resolves to a device that
// does not exist.
const assert = require('assert');
const UUID   = require('uuid-1345');
const addr   = require('../../lib/call-address');

describe('call-address: parsing', () => {
  it('splits a well-formed address', () => {
    assert.deepStrictEqual(addr.parseAddress('repo-scan/scanService.scan'),
      {device: 'repo-scan', service: 'scanService', action: 'scan'});
  });

  it('rejects a missing service or action', () => {
    assert.strictEqual(addr.parseAddress('repo-scan'), null);
    assert.strictEqual(addr.parseAddress('repo-scan/scanService'), null);
    assert.strictEqual(addr.parseAddress('repo-scan.scan'), null);
  });

  it('rejects extra delimiters rather than guessing', () => {
    assert.strictEqual(addr.parseAddress('a/b/c.d'), null);
    assert.strictEqual(addr.parseAddress('a/b.c.d'), null);
    assert.strictEqual(addr.parseAddress('a.b/c.d'), null);
  });

  it('rejects empty parts and non-strings', () => {
    assert.strictEqual(addr.parseAddress('/b.c'), null);
    assert.strictEqual(addr.parseAddress('a/.c'), null);
    assert.strictEqual(addr.parseAddress('a/b.'), null);
    assert.strictEqual(addr.parseAddress(null), null);
    assert.strictEqual(addr.parseAddress(42), null);
  });
});

describe('call-address: deviceID derivation', () => {
  it('matches the derivation CHDevice uses', () => {
    // Duplicated here on purpose: this literal is the contract. If someone
    // changes call-address.js's seed, this fails instead of every address
    // silently resolving to nothing.
    const expected = UUID.v5({
      namespace: UUID.namespace.url,
      name: 'https://registry.apemesh.com/packages/repo-scan'
    });
    assert.strictEqual(addr.deviceIDForName('repo-scan'), expected);
  });

  it('is the ID repo-scan actually has in the demo', () => {
    assert.strictEqual(addr.deviceIDForName('repo-scan'), '1359302a-e4fe-5c14-853b-f83638e8ca01');
  });
});

describe('call-address: resolving against a spec', () => {
  const spec = {device: {friendlyName: 'repo-scan', serviceList: {
    'urn:countinghouse-com:serviceID:scanService': {actionList: [{name: 'scan'}, {name: 'peek'}]}
  }}};

  it('resolves a service label to its full URN', () => {
    const r = addr.resolveAddress(spec, addr.parseAddress('repo-scan/scanService.scan'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.serviceID, 'urn:countinghouse-com:serviceID:scanService');
  });

  it('names the available services when the label matches none', () => {
    const r = addr.resolveAddress(spec, addr.parseAddress('repo-scan/nopeService.scan'));
    assert.strictEqual(r.ok, false);
    assert.ok(/nopeService/.test(r.message));
    assert.ok(/scanService/.test(r.message), 'message should list what does exist');
  });

  it('refuses an ambiguous label rather than picking one', () => {
    const ambiguous = {device: {friendlyName: 'x', serviceList: {
      'urn:vendor-a:serviceID:scanService': {actionList: [{name: 'scan'}]},
      'urn:vendor-b:serviceID:scanService': {actionList: [{name: 'scan'}]}
    }}};
    const r = addr.resolveAddress(ambiguous, addr.parseAddress('x/scanService.scan'));
    assert.strictEqual(r.ok, false);
    assert.ok(/vendor-a/.test(r.message) && /vendor-b/.test(r.message),
      'both candidates must be named');
  });

  it('names the available actions when the action is missing', () => {
    const r = addr.resolveAddress(spec, addr.parseAddress('repo-scan/scanService.nope'));
    assert.strictEqual(r.ok, false);
    assert.ok(/peek/.test(r.message), 'message should list what does exist');
  });

  it('reports a device with no serviceList instead of throwing', () => {
    const r = addr.resolveAddress({device: {friendlyName: 'x'}}, addr.parseAddress('x/y.z'));
    assert.strictEqual(r.ok, false);
  });
});
