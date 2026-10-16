// A peer hop whose metering request the main thread rate-limited cannot be
// billed, so it is refused rather than served free. Other metering errors
// (redis down) still fail open, as they always have.
const assert = require('assert');
const PeerChannel = require('../../lib/peer-channel');

function capture() {
  const got = {};
  return {got, reply: (err, data, metering) => Object.assign(got, {err, data, metering})};
}

describe('sandbox 13: metering under the message rate', () => {
  it('refuses the hop when the metering request was rate-limited', () => {
    const {got, reply} = capture();
    const err = new Error('too many messages'); err.code = 'RATE_LIMITED';
    PeerChannel.finishMeteredHop(err, {output: 1}, null, reply);
    assert.strictEqual(got.err.code, 'RATE_LIMITED');
    assert.strictEqual(got.data, null);
  });

  it('serves the hop when metering failed for another reason', () => {
    const {got, reply} = capture();
    PeerChannel.finishMeteredHop(new Error('redis down'), {output: 1}, null, reply);
    assert.strictEqual(got.err, null);
    assert.deepStrictEqual(got.data, {output: 1});
  });

  it('passes the metering result through on success', () => {
    const {got, reply} = capture();
    PeerChannel.finishMeteredHop(null, {output: 1}, {charged: 1}, reply);
    assert.deepStrictEqual(got.metering, {charged: 1});
  });
});
