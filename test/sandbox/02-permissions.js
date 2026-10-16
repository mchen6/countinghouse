// Pure functions: parsing a declaration, narrowing it by an operator policy
// entry, env resolution, host matching, policy file loading. No server.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const perms  = require('../../lib/module-permissions');
const policy = require('../../lib/module-policy');
const {startServer, stopServer} = require('../helpers/sandbox-server');

const pkg = (permissions) => ({name: 'm', version: '1.0.0', countinghouse: {permissions: permissions}});

describe('sandbox 02: permission declarations', () => {
  it('treats a package.json without a countinghouse key as declaring nothing', () => {
    const r = perms.parseDeclaration({name: 'm', version: '1.0.0'});
    assert.deepStrictEqual(r.problems, []);
    assert.deepStrictEqual(r.declared, {fs: [], net: [], env: [], limits: {}});
  });

  it('accepts a full valid declaration', () => {
    const r = perms.parseDeclaration(pkg({
      fs: [{path: '/var/log/app', access: 'r'}],
      net: [{host: 'API.Example.com', ports: [443]}, {host: '*.example.org'}],
      env: ['WEATHER_API_KEY'],
      limits: {heapMb: 128, maxBlockMs: 5000}
    }));
    assert.deepStrictEqual(r.problems, []);
    assert.deepStrictEqual(r.declared.net, [{host: 'api.example.com', ports: [443]}, {host: '*.example.org', ports: null}]);
    assert.deepStrictEqual(r.declared.limits, {heapMb: 128, maxBlockMs: 5000});
  });

  it('rejects reserved, relative, non-normalized and root fs paths, and bad access', () => {
    const r = perms.parseDeclaration(pkg({fs: [
      {path: '/data/x', access: 'r'}, {path: '/tmp', access: 'rw'}, {path: 'logs', access: 'r'},
      {path: '/var/log/../etc', access: 'r'}, {path: '/', access: 'r'}, {path: '/var/log', access: 'w'}
    ]}));
    assert.strictEqual(r.declared.fs.length, 0);
    assert.strictEqual(r.problems.length, 6, r.problems.join('\n'));
  });

  it('rejects bad hosts, ports, env names and limits', () => {
    const r = perms.parseDeclaration(pkg({
      net: [{host: 'a.*.com'}, {host: 'ok.com', ports: [0]}, {host: 'ok.com', ports: ['443']}],
      env: ['lower', 'OK_NAME'],
      limits: {heapMb: -1, externalMb: 1.5, other: 3}
    }));
    assert.deepStrictEqual(r.declared.env, ['OK_NAME']);
    assert.deepStrictEqual(r.declared.net, []);
    assert.deepStrictEqual(r.declared.limits, {});
    assert.strictEqual(r.problems.length, 7, r.problems.join('\n'));
  });

  it('rejects prototype-polluting access values like "constructor"', () => {
    const r = perms.parseDeclaration(pkg({
      fs: [{path: '/var/log/app', access: 'constructor'}]
    }));
    assert.deepStrictEqual(r.declared.fs, []);
    assert.ok(r.problems.some((p) => p.includes('access')), r.problems.join('\n'));
  });
});

describe('sandbox 02: narrowing by the operator policy', () => {
  const declared = perms.parseDeclaration(pkg({
    fs: [{path: '/var/log/app', access: 'rw'}],
    net: [{host: 'api.example.com', ports: [443, 8443]}, {host: '*.example.org'}],
    env: ['A', 'B'],
    limits: {heapMb: 512}
  })).declared;

  it('audit with no entry grants the declaration', () => {
    const r = perms.narrow(declared, null, {}, 'audit');
    assert.deepStrictEqual(r.fs, declared.fs);
    assert.deepStrictEqual(r.net, declared.net);
    assert.deepStrictEqual(r.envNames, ['A', 'B']);
    assert.strictEqual(r.approved, false);
  });

  it('enforce with no entry grants nothing outside the module', () => {
    const r = perms.narrow(declared, null, {}, 'enforce');
    assert.deepStrictEqual([r.fs, r.net, r.envNames], [[], [], []]);
  });

  it('enforce with no entry is fine for a module that declares nothing outside', () => {
    const empty = perms.parseDeclaration({name: 'm'}).declared;
    const r = perms.narrow(empty, null, {}, 'enforce');
    assert.deepStrictEqual(r.ignored, []);
    assert.deepStrictEqual(r.limits, perms.DEFAULT_LIMITS);
  });

  it('approve as-declared grants everything and takes env overrides', () => {
    const r = perms.narrow(declared, {approve: 'as-declared', env: {A: 'from-policy'}}, {}, 'enforce');
    assert.deepStrictEqual(r.envNames, ['A', 'B']);
    assert.deepStrictEqual(r.envOverrides, {A: 'from-policy'});
    assert.strictEqual(r.approved, true);
  });

  it('narrows paths, access, hosts and ports, and ignores anything wider', () => {
    const r = perms.narrow(declared, {
      fs: [{path: '/var/log/app/sub', access: 'r'}, {path: '/etc', access: 'r'}],
      net: [{host: 'api.example.com', ports: [443]}, {host: 'x.example.org'}, {host: 'evil.com'},
            {host: 'api.example.com', ports: [80]}],
      env: {A: null, C: 'x'}
    }, {}, 'enforce');
    assert.deepStrictEqual(r.fs, [{path: '/var/log/app/sub', access: 'r'}]);
    assert.deepStrictEqual(r.net, [{host: 'api.example.com', ports: [443]}, {host: 'x.example.org', ports: null}]);
    assert.deepStrictEqual(r.envNames, ['A']);
    assert.strictEqual(r.ignored.length, 4, r.ignored.join('\n'));
  });

  it('takes the smallest of request, top-level ceiling and entry ceiling', () => {
    const r = perms.narrow(declared, {approve: 'as-declared', limits: {heapMb: 300}}, {heapMb: 400, maxBlockMs: 2000}, 'audit');
    assert.deepStrictEqual(r.limits, {heapMb: 300, externalMb: 256, maxBlockMs: 2000});
  });

  it('resolves env values: override, then server env, then absent', () => {
    assert.deepStrictEqual(
      perms.resolveEnv(['A', 'B', 'C'], {A: 'p'}, {A: 's', B: 's', PATH: '/bin'}),
      {A: 'p', B: 's'});
  });

  it('matches hosts and ports, with one-label wildcards', () => {
    const net = [{host: 'api.example.com', ports: [443]}, {host: '*.example.org', ports: null}];
    assert.strictEqual(perms.hostAllowed(net, 'API.example.com', 443), true);
    assert.strictEqual(perms.hostAllowed(net, 'api.example.com', 80), false);
    assert.strictEqual(perms.hostAllowed(net, 'a.example.org', 80), true);
    assert.strictEqual(perms.hostAllowed(net, 'a.b.example.org', 80), false);
    assert.strictEqual(perms.hostAllowed(net, 'example.org', 80), false);
  });

  it('rejects non-normalized and relative fs paths in policy', () => {
    const r = perms.narrow(declared, {
      fs: [{path: '/var/log/app/../../../etc', access: 'r'}, {path: 'relative/path', access: 'r'}]
    }, {}, 'enforce');
    assert.deepStrictEqual(r.fs, []);
    assert.strictEqual(r.ignored.length, 2, r.ignored.join('\n'));
  });

  it('returns deep copies of fs and net so mutations do not corrupt the declaration', () => {
    const r = perms.narrow(declared, null, {}, 'audit');
    // Mutate the returned values
    r.fs[0].path = '/etc';
    r.net[0].host = 'evil.com';
    // Original declared should be unchanged
    assert.strictEqual(declared.fs[0].path, '/var/log/app');
    assert.strictEqual(declared.net[0].host, 'api.example.com');
  });
});

describe('sandbox 02: the policy file', function() {
  this.timeout(60000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-policy-'));
  after(() => fs.rmSync(dir, {recursive: true, force: true}));

  it('loads a valid file', () => {
    const file = path.join(dir, 'ok.json');
    fs.writeFileSync(file, JSON.stringify({limits: {heapMb: 128}, modules: {m: {approve: 'as-declared'}}}));
    assert.deepStrictEqual(policy.load(file).modules.m, {approve: 'as-declared'});
  });

  it('names the problem in a malformed file', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({modules: {m: {approve: 'yes'}}}));
    assert.throws(() => policy.load(file), /modules\.m\.approve/);
  });

  // The file holds env values; the error is logged and printed at startup.
  it('does not quote the file in a JSON syntax error', () => {
    const file = path.join(dir, 'syntax.json');
    fs.writeFileSync(file, '{"modules": {"m": {"env": {"K": sekret123}}}}');
    assert.throws(() => policy.load(file), (e) => /--modulePolicy/.test(e.message) && !/sekret123/.test(e.message));
  });

  it('rejects a null JSON file with a named error', () => {
    const file = path.join(dir, 'null.json');
    fs.writeFileSync(file, 'null');
    assert.throws(() => policy.load(file), /--modulePolicy/);
  });

  it('rejects a null modules entry with a named error', () => {
    const file = path.join(dir, 'null-entry.json');
    fs.writeFileSync(file, JSON.stringify({modules: {m: null}}));
    assert.throws(() => policy.load(file), /--modulePolicy/);
  });

  it('rejects invalid limit values in ceilings', () => {
    const file = path.join(dir, 'bad-limits.json');
    fs.writeFileSync(file, JSON.stringify({limits: {heapMb: 0}}));
    assert.throws(() => policy.load(file), /limits\.heapMb/);
  });

  it('returns modules with null prototype so constructor lookup is safe', () => {
    const file = path.join(dir, 'ok-constructor.json');
    fs.writeFileSync(file, JSON.stringify({limits: {}, modules: {}}));
    const p = policy.load(file);
    assert.strictEqual(p.modules.constructor, undefined);
  });

  it('stops startup on a missing policy file', async () => {
    let server = null;
    try {
      server = await startServer(9606, ['--debug', '--workerThread', '--modulePolicy', path.join(dir, 'nope.json')], {expectExit: true});
      assert.strictEqual(server.exitCode, 2);
      assert.ok(server.output.includes('--modulePolicy'), server.output);
    } finally { stopServer(server); }
  });
});
