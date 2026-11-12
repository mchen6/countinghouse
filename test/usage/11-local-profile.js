// The reviewer's decision (2026-11-11): a direct peer hop carries no usage
// call id, so in the single-identity profile its server calls would go
// unrecorded and the receipt would undercount. There, an explicit
// --directPeerChannels is refused at start (exit 2, "choose one"), and peer
// channels, on by default since 7.1.0, are off. Hosting keeps them.
const assert = require('assert');
const {profileStart} = require('../../lib/local-profile');

describe('the single-identity profile and direct peer channels', () => {
  it('an explicit --directPeerChannels in the profile is refused: choose one', () => {
    const o = {singleIdentity: true, directPeerChannels: true, directPeerChannelsGiven: true};
    assert.match(profileStart(o), /^--directPeerChannels and the single-identity profile: choose one$/);
  });

  it('in the profile without the flag, peer channels are off', () => {
    const o = {singleIdentity: true, directPeerChannels: true, directPeerChannelsGiven: false};
    assert.strictEqual(profileStart(o), null);
    assert.strictEqual(o.directPeerChannels, false);
  });

  // The real start path (the review of #90, 3): framework.js runs profileStart
  // right after the --stdio/--port check, before B's own refusals.
  describe('through the real start', function() {
    this.timeout(30000);
    const {spawnSync} = require('child_process');
    const fsx = require('fs');
    const os = require('os');
    const path = require('path');
    const ENTRY = path.join(__dirname, '..', '..', 'bin', 'countinghouse-stdio.js');
    let home;
    beforeEach(() => { home = fsx.mkdtempSync(path.join(os.tmpdir(), 'ch-profile-')); });
    afterEach(() => { fsx.rmSync(home, {recursive: true, force: true}); });
    const start = (...extra) => spawnSync(process.execPath, [ENTRY, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), ...extra],
      {encoding: 'utf8', timeout: 25000, input: ''});

    it('the profile with an explicit --directPeerChannels exits 2 with "choose one"', () => {
      const r = start('--directPeerChannels');
      assert.strictEqual(r.status, 2, r.stderr);
      assert.match(r.stderr, /--directPeerChannels and the single-identity profile: choose one/);
    });

    it('without it the profile check passes and the start goes on (to B\'s later checks)', () => {
      const r = start();
      assert.doesNotMatch(r.stderr, /choose one/);
    });

    it('with --authConfigPath it is not the profile, and the flag is not refused here', () => {
      const auth = path.join(home, 'auth.json');
      fsx.writeFileSync(auth, '{}');
      const r = start('--authConfigPath', auth, '--directPeerChannels');
      assert.doesNotMatch(r.stderr, /single-identity profile: choose one/);
    });
  });

  it('outside the profile nothing changes, the flag or not', () => {
    for (const given of [true, false]) {
      const o = {singleIdentity: false, directPeerChannels: true, directPeerChannelsGiven: given};
      assert.strictEqual(profileStart(o), null);
      assert.strictEqual(o.directPeerChannels, true);
    }
  });

  it('cli-options records whether --directPeerChannels was given, and keeps it out of what workers get', () => {
    const options = require('../../lib/cli-options');
    options.setOptions({redisUrl: 'redis://127.0.0.1:9749', directPeerChannels: true});
    assert.strictEqual(options.directPeerChannelsGiven, true);
    options.setOptions({redisUrl: 'redis://127.0.0.1:9749', directPeerChannels: 1});
    assert.strictEqual(options.directPeerChannelsGiven, true, '--directPeerChannels=1 is given too');
    options.setOptions({redisUrl: 'redis://127.0.0.1:9749'});
    assert.strictEqual(options.directPeerChannelsGiven, false);
    assert.strictEqual(options.directPeerChannels, true, 'still on by default');
    assert.ok(!('directPeerChannelsGiven' in options.getOptions()));
    for (const off of [false, 'false']) {
      options.setOptions({redisUrl: 'redis://127.0.0.1:9749', directPeerChannels: off});
      assert.deepStrictEqual([options.directPeerChannels, options.directPeerChannelsGiven], [false, false], `--directPeerChannels=${off} is off (review of #90, 4)`);
    }
    options.setOptions({});
  });
});
