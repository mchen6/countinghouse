// identityForModule on both shipped auth backends. No server, no ports.
//
// The sqlite half probes the native binding IN A CHILD PROCESS and skips on
// failure. A sqlite3 built against the wrong Node ABI does not throw -- it
// SIGSEGVs during module registration and takes the whole mocha run down
// with zero output, which looks like a broken suite rather than one bad
// addon. Same technique and reasoning as test/auth/03-sqlite-provider-unit.js.
const assert    = require('assert');
const fs        = require('fs');
const os        = require('os');
const path      = require('path');
const spawnSync = require('child_process').spawnSync;

require('../../lib/cli-options').setOptions({});
const FileAuthProvider = require('../../lib/auth/file-provider');

function tmpAuthFile(config) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ident-')), 'auth.json');
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

describe('file provider: identityForModule', () => {
  it('returns the identity that lists the module', (done) => {
    const p = tmpAuthFile({
      'demo-key': {userName: 'demo', devices: ['*']},
      'repo-review-internal': {userName: 'ri', devices: ['d1'], runsModules: ['repo-review']}
    });
    new FileAuthProvider({configPath: p}).identityForModule('repo-review', (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.apiKey, 'repo-review-internal');
      assert.strictEqual(result.conflicts, null);
      done();
    });
  });

  it('returns null for a module nothing binds', (done) => {
    const p = tmpAuthFile({'demo-key': {userName: 'demo', devices: ['*']}});
    new FileAuthProvider({configPath: p}).identityForModule('repo-review', (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.apiKey, null);
      assert.strictEqual(result.conflicts, null);
      done();
    });
  });

  it('reports every claimant when two identities bind the same module', (done) => {
    const p = tmpAuthFile({
      'one': {userName: 'one', devices: [], runsModules: ['repo-review']},
      'two': {userName: 'two', devices: [], runsModules: ['repo-review']}
    });
    new FileAuthProvider({configPath: p}).identityForModule('repo-review', (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.apiKey, null, 'must not pick one silently');
      assert.deepStrictEqual(result.conflicts.sort(), ['one', 'two']);
      done();
    });
  });

  it('ignores a runsModules that is not an array', (done) => {
    const p = tmpAuthFile({'one': {userName: 'one', devices: [], runsModules: 'repo-review'}});
    new FileAuthProvider({configPath: p}).identityForModule('repo-review', (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.apiKey, null);
      done();
    });
  });
});

function probeSqlite3() {
  const probe = spawnSync(process.execPath, ['-e', 'require("sqlite3")'], {encoding: 'utf8'});
  if (probe.status === 0) return null;
  if (probe.signal != null) return `native binding crashed the probe with ${probe.signal}`;
  return (probe.stderr || '').split('\n')[0];
}

describe('sqlite provider: identityForModule', () => {
  const skipReason = probeSqlite3();
  let provider;

  before(function() {
    if (skipReason != null) return this.skip();
    const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ident-db-')), 'auth.sqlite3');
    provider = new SqliteAuthProvider({dbPath: dbPath});
  });

  it('returns the identity bound to the module', (done) => {
    provider.db.run('INSERT INTO module_identities (moduleName, apiKey) VALUES (?, ?)',
      ['repo-review', 'repo-review-internal'], (err) => {
        assert.ifError(err);
        provider.identityForModule('repo-review', (err2, result) => {
          assert.ifError(err2);
          assert.strictEqual(result.apiKey, 'repo-review-internal');
          assert.strictEqual(result.conflicts, null);
          done();
        });
      });
  });

  it('returns null for a module nothing binds', (done) => {
    provider.identityForModule('not-bound', (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.apiKey, null);
      done();
    });
  });
});
