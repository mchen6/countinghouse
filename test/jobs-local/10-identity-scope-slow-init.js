'use strict';
// R-flake-jobs-local-01: test/helpers/identity-scope's useIdentity() makes
// its before() and after() hooks when it is called, and mocha gives a hook
// the timeout its suite has at that moment. jobs-local 01 called it before
// its describe's this.timeout(20000), so the identity setup (an initSync and
// an addKey per key, all synchronous file work) ran under mocha's default
// 2 s, and a slow Windows runner went past it; its teardown (a tree removed
// with retries) is the same. Both take their own time, whatever the suite's
// timeout is when useIdentity is called.
const assert = require('assert');
const identity = require('../../lib/identity');

describe('jobs-local 10: the identity scope\'s setup and teardown take their own time (R-flake-jobs-local-01)', () => {
  // a setup and a teardown well past the suite's own timeout (forced: a busy
  // wait, as on a slow runner; mocha's own timer is wall-clock, so the
  // margin is wide both ways: the waits are four times the suite's timeout,
  // and a small part of the helper's own bound)
  const SLOW_MS = 200;
  const busy = () => { const until = Date.now() + SLOW_MS; while (Date.now() < until) { /* a slow runner */ } };
  const realInit = identity.initSync;
  const realState = identity.stateForTests;
  let restored = false;
  before(() => {
    identity.initSync = function(...a) { busy(); return realInit.apply(this, a); };
    identity.stateForTests = function(...a) {
      const s = realState.apply(this, a);
      return {restore() { busy(); restored = true; return s.restore(); }};
    };
  });
  after(() => {
    identity.initSync = realInit;
    identity.stateForTests = realState;
    assert.ok(restored, 'the teardown ran, past the suite\'s timeout');
  });

  describe('a suite whose timeout is smaller than the setup takes', function() {
    this.timeout(SLOW_MS / 4);
    require('../helpers/identity-scope').useIdentity(['k-slow']);
    it('its identity is set up', () => {
      assert.ok(identity.ready());
    });
  });
});
