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
  });
});
