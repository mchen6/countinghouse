// A log line never carries an API key. Where only the key is in hand -- a
// peer channel's grant record, a module's ctx.recordUsage in its worker --
// the line names it by a short fingerprint instead (`key sha256:<8 hex>`),
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

  it('CHUtil.recordUsage names the caller by fingerprint', () => {
    assertFingerprinted(loggedBy(`lib('countinghouse-util').recordUsage(KEY, 'some-tool', 1, () => {});`));
  });
});
