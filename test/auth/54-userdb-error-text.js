// The auth provider's own failure text never reaches the caller (the
// back-sweep, 11-18): user-auth answered SYSTEM_ERROR_USERDB_NA with the
// provider's err.message, which can name a CouchDB or sqlite host or port,
// to a caller that may not even be authenticated. It answers with the
// catalogue's text now, and the detail goes to the log.
// Run in a child process: lib/auth is replaced in its require cache.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');

const LIB = path.join(__dirname, '..', '..', 'lib');

describe('auth 54: the auth provider\'s failure text stays in the log', function() {
  this.timeout(30000);

  it('a provider error answers SYSTEM_ERROR_USERDB_NA in the catalogue\'s words; the host and port are only in the log', () => {
    const script = `
      const authPath = require.resolve(${JSON.stringify(path.join(LIB, 'auth'))});
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: {getAuthProvider: () => ({
        authenticate: (appKey, deviceID, serviceID, actionName, cb) => cb(Object.assign(new Error('connect ECONNREFUSED couch.internal.example:5984'), {code: 'ECONNREFUSED'}))
      })}};
      const logged = [];
      const LOG = require(${JSON.stringify(path.join(LIB, 'logger'))});
      LOG.E = (e) => logged.push(String(e && e.message));
      const userAuth = require(${JSON.stringify(path.join(LIB, 'user-auth'))});
      userAuth(null, null, 'dev', 'some-key', 'svc', 'act', () => {}, (err) => {
        process.stdout.write('OUT ' + JSON.stringify({code: err && err.code, message: err && err.message, logged}) + '\\n');
      });`;
    const r = spawnSync(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 20000});
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
    assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
    const o = JSON.parse(line.slice(4));
    assert.strictEqual(o.code, 'SYSTEM_ERROR_USERDB_NA');
    assert.ok(!/couch\.internal|5984|ECONNREFUSED/.test(o.message), `the caller sees: ${o.message}`);
    assert.ok(o.logged.some((l) => /couch\.internal\.example:5984/.test(l)), `logged: ${JSON.stringify(o.logged)}`);
  });
});
