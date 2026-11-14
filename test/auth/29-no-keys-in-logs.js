// A log line never carries an API key. Where only the key is in hand -- a
// peer channel's grant record -- the line names it by a short fingerprint
// instead (`key sha256:<8 hex>`),
// enough to tell two tenants apart in a log, not to recover the key.
//
// Each case runs in a child process: requiring the peer channel broker or
// countinghouse-util on a main thread opens Redis clients, which would keep
// this (no --exit) mocha run alive.
const assert    = require('assert');
const crypto    = require('crypto');
const path      = require('path');
const spawnSync = require('child_process').spawnSync;

const LIB = path.join(__dirname, '..', '..', 'lib');
const KEY = 'tenant-secret-key-0123456789abcdef';
const FINGERPRINT = `key sha256:${crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 8)}`;

// Runs `body` with LOG.I captured and returns the lines it logged.
function loggedBy(body) {
  const script = `
    const lib = (m) => require(${JSON.stringify(LIB)} + '/' + m);
    lib('cli-options').setOptions({workerThread: false});
    const LOG = lib('logger');
    LOG.createLogger(false);
    const lines = [];
    LOG.I = (m) => { lines.push(String(m)); return m; };
    const KEY = ${JSON.stringify(KEY)};
    ${body}
    process.stdout.write('LINES ' + JSON.stringify(lines) + '\\n');
    process.exit(0);`;
  const run = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 20000});
  const out = (run.stdout || '').split('\n').find((l) => l.startsWith('LINES '));
  assert.ok(out != null, `no output: ${run.stdout} ${run.stderr}`);
  return JSON.parse(out.slice('LINES '.length));
}

function assertFingerprinted(lines) {
  assert.strictEqual(lines.length, 1, JSON.stringify(lines));
  assert.ok(!lines[0].includes(KEY), lines[0]);
  assert.ok(lines[0].includes(FINGERPRINT), lines[0]);
}

describe('auth 29: no API key in a log line', function() {
  this.timeout(30000);

  it('a peer channel closed for a revoked grant names the tenant by fingerprint', () => {
    assertFingerprinted(loggedBy(`
      const PeerChannelBroker = lib('peer-channel-broker');
      const broker = new PeerChannelBroker({});
      const entry = {callerWM: {workerId: 1, sendPeerInvalidateToChild: () => {}}, calleeWM: {workerId: 2, sendPeerInvalidateToChild: () => {}}};
      broker.channelRegistry['1:2'] = entry;
      broker.closeRevoked('1:2', entry, {appKey: KEY, deviceID: 'dev-1'}, {code: 'DEVICE_ACCESS_DENIED'});`));
  });

  // R2-1 Task 5: a module's recordUsage has the caller's opaque id in hand,
  // never a key, and its line names that id.
  it('CHUtil.recordUsage names the caller by its id', () => {
    const ID = `u_${'A'.repeat(22)}`;
    const lines = loggedBy(`lib('countinghouse-util').recordUsage(${JSON.stringify(ID)}, 'some-tool', 1, () => {});`);
    assert.strictEqual(lines.length, 1, JSON.stringify(lines));
    assert.ok(lines[0].includes(ID), lines[0]);
  });

  // R2-1 Task 5 (plan step 3b): an unknown key one character off a real one
  // is refused SYSTEM_ERROR_UNKNOWN_USER with no piece of either key, by the
  // file and sqlite providers and by user-auth, in the answer or the log.
  it('a near-miss key leaves no 6-character piece of either key in the answer or the log', () => {
    const NEAR = `${KEY.slice(0, -1)}${KEY.endsWith('f') ? 'e' : 'f'}`;
    const run = spawnSync(process.execPath, ['-e', `
      const fs = require('fs'), os = require('os'), path = require('path');
      const lib = (m) => require(${JSON.stringify(LIB)} + '/' + m);
      lib('cli-options').setOptions({workerThread: false});
      const LOG = lib('logger');
      LOG.createLogger(false);
      const seen = [];
      for (const level of ['I', 'W', 'E', 'D']) LOG[level] = (m) => { seen.push(String(m && m.stack ? m.stack : m)); return m; };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-near-miss-'));
      const configPath = path.join(dir, 'auth.json');
      fs.writeFileSync(configPath, JSON.stringify({${JSON.stringify(KEY)}: {userName: 'tenant', devices: ['*']}}));
      const FileAuthProvider = lib('auth/file-provider');
      const file = new FileAuthProvider({configPath});
      const answers = [];
      const done = () => { fs.rmSync(dir, {recursive: true, force: true}); process.stdout.write('OUT ' + JSON.stringify({answers, seen}) + '\\n'); process.exit(0); };
      file.authenticate(${JSON.stringify(NEAR)}, 'dev-1', null, null, (err, r) => {
        answers.push(JSON.stringify([err && err.message, r && r.err && r.err.message, r && r.err && r.err.code]));
        let sqlite = null;
        try { require.resolve('sqlite3'); sqlite = lib('auth/sqlite-provider'); } catch (e) { sqlite = null; }
        if (sqlite == null) return done();
        const p = new sqlite({dbPath: path.join(dir, 'auth.db')});
        p.db.serialize(() => p.db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', [${JSON.stringify(KEY)}, 'tenant']));
        p.authenticate(${JSON.stringify(NEAR)}, 'dev-1', null, null, (e2, r2) => {
          answers.push(JSON.stringify([e2 && e2.message, r2 && r2.err && r2.err.message, r2 && r2.err && r2.err.code]));
          done();
        });
      });`], {encoding: 'utf8', timeout: 20000});
    const line = (run.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
    assert.ok(line != null, `no output: ${run.stdout} ${run.stderr}`);
    const {answers, seen} = JSON.parse(line.slice(4));
    assert.ok(answers.length >= 1 && answers.every((a) => a.includes('SYSTEM_ERROR_UNKNOWN_USER')), answers.join('\n'));
    const text = answers.concat(seen).join('\n');
    for (const k of [KEY, NEAR]) {
      for (let i = 0; i + 6 <= k.length; i++) {
        assert.ok(!text.includes(k.slice(i, i + 6)), `a piece of a key ("${k.slice(i, i + 6)}") in:\n${text}`);
      }
    }
  });
});
