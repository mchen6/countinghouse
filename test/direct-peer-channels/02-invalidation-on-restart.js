const request = require('supertest');

const url = 'http://127.0.0.1:9527';

// docs/direct-peer-channels-design.md section 5, step 2's required test:
// "调用进行中热重载目标模块 -> 调用方收到明确错误且下一次调用成功走新实例" (reload the
// target module while a call is outstanding -> the caller gets a clear
// error and the next call succeeds against the new instance).
//
// Uses errTestService/testErrorInfo (not 服务名称/API名称, used by
// 01-echo-roundtrip.js) specifically because its handler
// (echo-device-client-module/errTestService-testErrorInfo.js) correctly
// propagates errors from the underlying ServiceClient.invoke call --
// 服务名称/API名称's handler discards its callback's `err` entirely
// (`function(err, data) { return callback(null, data); }`), which would
// mask the very PEER_GONE/DEVICE_NOT_FOUND codes this test needs to see.
// testErrorInfo's target action on echo-device-module is *itself*
// designed to always return a device-defined fault (that's its whole
// purpose, per its own api.json description) -- DEVICE_INVOKE_FAIL is
// therefore the expected steady-state result both before and after the
// restart; PEER_GONE/DEVICE_NOT_FOUND appearing only *during* the restart
// window is the actual signal this test is after.
describe('direct-peer-channels 02: port invalidation on module restart (D4)', function() {
  this.timeout(0);

  const ECHO_DEVICE_CLIENT_ID = 'efefb416-bdc0-54eb-96a9-38f96f52779d'; // echo-device-client-module

  function invoke(cb) {
    const t0 = Date.now();
    request(url).post(`/devices/${ECHO_DEVICE_CLIENT_ID}/invoke-action`)
    .set('X-CH-Key', 'aabbcc')
    .send({serviceID: 'urn:example-com:serviceID:errTestService', actionName: 'testErrorInfo', input: {foo: 'test'}})
    .end((err, res) => {
      if (err) return cb(err);
      return cb(null, {ms: Date.now() - t0, code: res.body != null ? res.body.code : null});
    });
  }

  it('a channel established before restart, invalidated fast (not a ~30s hang) during it, and working again after', (done) => {
    // establish the channel -- steady state is DEVICE_INVOKE_FAIL (the
    // target action's own intentional fault, see header comment), which
    // also confirms the call actually reached the device successfully.
    invoke((err, first) => {
      if (err) return done(err);
      if (first.code !== 'DEVICE_INVOKE_FAIL') {
        return done(new Error(`direct-peer-channels 02 fail: expected DEVICE_INVOKE_FAIL establishing the channel, got: ${first.code}`));
      }

      // fire the restart without waiting for it, then race several calls
      // against the teardown+recreate window.
      request(url).post('/restart-module')
      .set('X-CH-Key', 'aabbcc') // /restart-module is now admin-gated (lib/routes/admin-only.js) -- shared with test8.js's server, same debugKey
      .send({path: './pre-installed-packages/echo-device-module', name: 'echo-device-module', version: '1.3.0'})
      .end(() => {}); // response timing isn't needed -- the race calls below are what matters

      const raceResults = [];
      let racesRemaining = 5;
      const raceInterval = setInterval(() => {
        invoke((err, result) => {
          if (err) { raceResults.push({error: err.message}); } else { raceResults.push(result); }
        });
        racesRemaining--;
        if (racesRemaining === 0) {
          clearInterval(raceInterval);
          // give the races a moment to all resolve before inspecting them
          setTimeout(() => { checkRaces(); }, 500);
        }
      }, 200);

      function checkRaces() {
        // Every race call must resolve fast -- PeerChannel's own local
        // timeout (options.requestTimeout, default 30000ms) is the worst
        // case if invalidation silently failed to fire; anything even
        // approaching that would mean a stale port was hanging instead of
        // failing fast. 5000ms is a generous margin over what was observed
        // manually (single-digit to low-double-digit ms).
        for (let i = 0; i < raceResults.length; i++) {
          const r = raceResults[i];
          if (r.ms == null) return done(new Error(`direct-peer-channels 02 fail: race call ${i} errored: ${JSON.stringify(r)}`));
          if (r.ms > 5000) {
            return done(new Error(`direct-peer-channels 02 fail: race call ${i} took ${r.ms}ms -- looks like it hung waiting for a stale port instead of being invalidated (got code: ${r.code})`));
          }
        }

        // at least one race call must show the invalidation actually firing
        // (PEER_GONE) or its direct consequence (DEVICE_NOT_FOUND, once
        // re-brokering finds the device briefly absent from deviceMap
        // during the teardown/recreate window) -- if every race call
        // instead saw DEVICE_INVOKE_FAIL throughout, that would mean the
        // restart hadn't actually started affecting this channel yet by
        // the time the races ran, and the test wouldn't have exercised D4
        // at all.
        const sawChannelDisruption = raceResults.some((r) => {
          return r.code === 'PEER_GONE' || r.code === 'DEVICE_NOT_FOUND';
        });
        if (sawChannelDisruption !== true) {
          return done(new Error(`direct-peer-channels 02 fail: no race call observed PEER_GONE or DEVICE_NOT_FOUND -- test did not exercise the restart window: ${JSON.stringify(raceResults)}`));
        }

        // Finally, wait for the new worker instance to be fully back
        // online and confirm the channel transparently re-established
        // itself against it (D1's "对调用方模块代码完全透明"). Polled, not a
        // single fixed delay -- restart-module's own unload wait is
        // ~4-5s, and module rediscovery afterward is a further fixed
        // ~5s (sandbox.js's 'discover-device' handling), so the total
        // time before the new instance is actually queryable varies and
        // can comfortably exceed 10s under load.
        let finalAttemptsLeft = 20; // ~20s budget at 1s/attempt
        function pollFinal() {
          invoke((err, final) => {
            if (err) return done(err);
            if (final.code === 'DEVICE_INVOKE_FAIL') return done();
            finalAttemptsLeft--;
            if (finalAttemptsLeft <= 0) {
              return done(new Error(`direct-peer-channels 02 fail: expected DEVICE_INVOKE_FAIL after restart settled (channel re-established against new instance), still getting: ${final.code}`));
            }
            return setTimeout(pollFinal, 1000);
          });
        }
        setTimeout(() => {
          pollFinal();
        }, 3000);
      }
    });
  });
});
