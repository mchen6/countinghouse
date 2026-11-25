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

describe('call-address: deviceID derivation (8.0: countinghouse\'s own namespace)', () => {
  // Literals on purpose: they are the contract. A change to the namespace or
  // the derivation reassigns every device's ID, and every grant naming one
  // stops matching: it fails here first.
  it('pins the namespace and two names\' exact IDs', () => {
    assert.strictEqual(addr.CH_DEVICE_NS, '7b3e4564-8366-4d06-b118-ae152a079f0f');
    assert.strictEqual(addr.deviceIDForName('repo-scan'), 'a052935d-adee-5295-b83f-a4b0eadbb2e7');
    assert.strictEqual(addr.deviceIDForName('echo-device'), 'e18f97d6-340a-5517-be3a-91820edc1075');
    assert.strictEqual(addr.deviceIDForName('repo-scan'), UUID.v5({namespace: '7b3e4564-8366-4d06-b118-ae152a079f0f', name: 'repo-scan'}));
  });

  // Every device's friendlyName in the repo's specs, and every file under
  // the code folders: none holds a pre-8.0 ID (lib/pre-8-device-ids.js, the
  // one place that derives them, aside); and a hard-coded ID in module code,
  // which cannot compute one, is its module's ID now.
  const fs = require('fs');
  const path = require('path');
  const {execFileSync} = require('child_process');
  const ROOT = path.join(__dirname, '..', '..');
  const tracked = (dirs) => execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '--', ...dirs], {cwd: ROOT, encoding: 'utf8'}).split('\n').filter(Boolean);
  const friendlyNames = () => {
    const names = new Set();
    for (const f of tracked(['.']).filter((n) => /\.(json|js)$/.test(n))) {
      let text;
      try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
      for (const m of text.matchAll(/["']?friendlyName["']?\s*:\s*["']([^"'\n]+)["']/g)) names.add(m[1]);
    }
    return names;
  };

  it('no pre-8.0 device ID of any friendlyName in the repo is left anywhere but the history (docs, CHANGELOG, MIGRATION)', () => {
    const {pre8DeviceIDForName} = require('../../lib/pre-8-device-ids');
    const names = friendlyNames();
    assert.ok(names.has('echo-device') && names.has('repo-scan'), `the specs were read: ${names.size} names`);
    const old = new Map([...names].map((n) => [pre8DeviceIDForName(n), n]));
    const found = [];
    // every tracked file but the history (docs/, the CHANGELOG, MIGRATION.md)
    // and the one file that derives the old IDs
    const history = (n) => n.startsWith('docs/') || n === 'CHANGELOG.md' || n === 'MIGRATION.md' || n === 'lib/pre-8-device-ids.js';
    for (const f of tracked(['.']).filter((n) => !history(n))) {
      let text;
      try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
      for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g)) if (old.has(m[0])) found.push(`${f}: ${old.get(m[0])}`);
    }
    assert.deepStrictEqual(found, []);
  });

  // module code names a device by ID only where it cannot call it by name
  // (the CDIF-era echo-device-client handlers, which declare no calls):
  // there the literal is pinned to the derivation; a module that declares
  // its calls holds no ID at all (ctx.call by name)
  it('module code\'s hard-coded device IDs are their modules\' IDs now; a module that declares its calls holds none', () => {
    const at = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const [f, names] of [
      ['pre-installed-packages/echo-device-client-module/handlers/errTestService/testErrorInfo.js', ['echo-device']],
      ['pre-installed-packages/echo-device-client-module/handlers/x/API.js', ['echo-device']]
    ]) {
      for (const n of names) assert.ok(at(f).includes(addr.deviceIDForName(n)), `${f}: ${n}`);
    }
    const UUID_LITERAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
    for (const f of ['pre-installed-packages/composite-demo/handlers/compositeService/run.js',
      'pre-installed-packages/perf-caller-demo/handlers/perfCallerService/run.js', 'test/fixtures/ctx-compose-module/actions.js']) {
      assert.doesNotMatch(at(f), UUID_LITERAL, f);
    }
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
