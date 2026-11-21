'use strict';
// tools/call's second gate (#458's high review, 3). The grant set that
// chooses tools/call's answer for a tool the caller can't see is kept up to
// 5 s (tool-registry grantsForCall); authorisation is still userAuth's read
// on every call. The sqlite provider has no change signal, so a grant
// revoked through its CLI leaves a kept set stale for up to 5 s: in that
// window a call of the revoked device's tool must be refused by userAuth
// (-32603, USER_HAS_NO_DEVICE's text), plain and task-augmented, and never
// run; after it, the uniform answer for a tool the caller can't see.
const assert = require('assert');
const path = require('path');
const {execFileSync} = require('child_process');
const request = require('supertest');
const waitForReady = require('../helpers/wait-for-ready');
const {testPort, redisFlag, startShell, stopAll} = require('../helpers/test-env');
const {deviceIDForName} = require('../../lib/call-address');
const {CountinghouseError} = require('../../lib/countinghouse-error');
const tmp = require('../helpers/test-tmp').forFile(['ch-auth-55-']);

const ROOT = path.join(__dirname, '..', '..');
const PORT = testPort(9795);
const url = `http://127.0.0.1:${PORT}`;
const KEY = `k55-${require('crypto').randomBytes(12).toString('hex')}`;
const ECHO = deviceIDForName('echo-device');
const TOOL = 'echo_device_echoservice_echo';
const ARGS = {foo: [{item1: 'x'}], bar: 'y'};
const NO_DEVICE = new CountinghouseError('USER_HAS_NO_DEVICE').message;

describe('auth 55: behind a stale grant set, userAuth still refuses a revoked device (sqlite)', function() {
  this.timeout(120000);
  let db;
  // (a key goes on stdin: test/helpers/auth-cli.js)
  const cli = (args) => { const k = require('../helpers/auth-cli').keyed(args); return execFileSync(process.execPath, [path.join(ROOT, 'bin', 'countinghouse-auth-sqlite.js'), '--dbPath', db].concat(k.args),
    {cwd: ROOT, input: k.input, stdio: ['pipe', 'pipe', 'pipe']}); };
  const call = (extra = {}) => new Promise((resolve, reject) => request(url).post('/mcp').set('Content-Type', 'application/json')
    .set('X-CH-Key', KEY)
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: Object.assign({name: TOOL, arguments: ARGS}, extra)})
    .end((err, res) => (err ? reject(err) : resolve(res.body))));

  before((done) => {
    db = path.join(tmp.mkdtemp('ch-auth-55-'), 'auth.sqlite3');
    cli(['add-user', KEY, 'k55']);
    cli(['grant', KEY, ECHO]);
    waitForReady(startShell(`"./bin/countinghouse"${redisFlag()} --workerThread --bindAddr 127.0.0.1 --port ${PORT}`
      + ` --authProvider sqlite --authConfigPath ${db} --loadModule ./pre-installed-packages/echo-device-module`,
    {cwd: ROOT}, () => {}), done);
  });
  after((done) => { stopAll(done); });

  // the revocation as the CLI makes it (its row gone), in this process: a
  // few milliseconds, so the call after it is well inside the 5 s window
  // even on a slow runner (spawning the CLI could take seconds there)
  const revoke = () => new Promise((resolve, reject) => {
    const sqlite3 = require('sqlite3');
    const handle = new sqlite3.Database(db, (err) => {
      if (err) return reject(err);
      return handle.run('DELETE FROM user_devices WHERE apiKey = ? AND deviceID = ?', [KEY, ECHO], (e) => handle.close(() => (e ? reject(e) : resolve())));
    });
  });
  for (const [label, extra] of [['plain', {}], ['task-augmented', {task: {ttl: 60000}}]]) {
    it(`${label}: within the 5 s a revoked device is refused by userAuth and does not run; after them it is an unknown tool`, async function() {
      cli(['grant', KEY, ECHO]);
      await new Promise((r) => setTimeout(r, 5100));   // any set kept from before has lapsed
      const began = Date.now();
      const granted = await call(extra);
      assert.strictEqual(granted.error, undefined, JSON.stringify(granted));
      // the grant set is now kept; the revocation reaches no cache
      await revoke();
      const stale = await call(extra);
      // (a runner so slow the window lapsed first tests nothing here: said, not failed)
      if (Date.now() - began >= 4500) this.skip();
      assert.strictEqual(stale.result, undefined, JSON.stringify(stale));
      assert.deepStrictEqual({code: stale.error.code, message: stale.error.message}, {code: -32603, message: NO_DEVICE});
      await new Promise((r) => setTimeout(r, 5100));
      const lapsed = await call(extra);
      assert.deepStrictEqual(lapsed.error, {code: -32602, message: `unknown tool: ${TOOL}`});
    });
  }

  tmp.hooks();
});
