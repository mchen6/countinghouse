// --directPeerChannels is on unless the operator opts out. lib/cli-options.js
// is the one place that decides it: lib/service-client.js's isRemoteThread
// branch reads options.directPeerChannels, and the main thread hands its
// resolved options to every worker (getOptions() -> the worker's own
// setOptions(), lib/sandbox.js), so the handoff is tested here too -- an
// opt-out that the main thread honours and a worker forgets would split one
// server across both hop paths.
//
// Which path a running server actually takes is covered where it can be
// observed: test1.js and the main-thread blocks of composition/04, auth/13
// and direct-peer-channels/06 pin --no-directPeerChannels; test8.js and the
// direct blocks of auth/13 and direct-peer-channels/06 pin
// --directPeerChannels; composition/04b and
// examples/log-triage/verify-cost-bound.js run with no flag at all.
const assert   = require('assert');
const minimist = require('minimist');

const options = require('../../lib/cli-options');

function parse(args) {
  options.setOptions(minimist(args));
  return options;
}

describe('composition 12: --directPeerChannels is the default', () => {
  // every other file in this mocha process expects the bare defaults
  after(() => { options.setOptions({}); });

  it('is on when no flag is given', () => {
    assert.strictEqual(parse([]).directPeerChannels, true);
  });

  it('stays on when the flag is given explicitly', () => {
    assert.strictEqual(parse(['--directPeerChannels']).directPeerChannels, true);
  });

  it('is off with --no-directPeerChannels', () => {
    assert.strictEqual(parse(['--no-directPeerChannels']).directPeerChannels, false);
  });

  it('hands an opt-out to a worker unchanged', () => {
    const forWorker = parse(['--no-directPeerChannels']).getOptions();
    assert.strictEqual(forWorker.directPeerChannels, false);
    options.setOptions(forWorker);
    assert.strictEqual(options.directPeerChannels, false);
  });

  it('hands the default to a worker unchanged', () => {
    const forWorker = parse([]).getOptions();
    assert.strictEqual(forWorker.directPeerChannels, true);
    options.setOptions(forWorker);
    assert.strictEqual(options.directPeerChannels, true);
  });
});
