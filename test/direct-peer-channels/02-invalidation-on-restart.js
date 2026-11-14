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

      // The window opens when the old worker has ended (it may take up to 3 s
      // to acknowledge; until then the channel still reaches it) and closes
      // when the new one is online. test8.js holds it open 2 s
      // (COUNTINGHOUSE_TEST_RESTART_HOLD_MS, lib/module-manager.js), whatever
      // the boot time. So calls go back to back from the moment the restart is
      // asked for, until the window has opened (a PEER_GONE or
      // MODULE_RELOADING) and closed again (the steady DEVICE_INVOKE_FAIL), or
      // 60 s: a call of a few ms cannot miss a 2 s window. Fixed delays did
      // (CI run 43361707636: five calls at 200 ms steps, all before it opened
      // or after it closed).
      const raceResults = [];
      const raceUntil = Date.now() + 60000;
      let opened = false;
      let openedAt = null;
      const requestedAt = Date.now();
      function race() {
        invoke((err, result) => {
          raceResults.push(err ? {error: err.message} : Object.assign(result, {at: Date.now()}));
          const code = err ? null : result.code;
          if ((code === 'PEER_GONE' || code === 'MODULE_RELOADING') && !opened) { opened = true; openedAt = Date.now(); }
          if ((opened && code === 'DEVICE_INVOKE_FAIL') || Date.now() > raceUntil) return checkRaces();
          return setImmediate(race);
        });
      }
      race();

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
          if (r.code === 'DEVICE_NOT_FOUND') {
            return done(new Error(`direct-peer-channels 02 fail: race call ${i} got DEVICE_NOT_FOUND inside a restart window -- the reload's state was recorded too late or cleared too early: ${JSON.stringify(raceResults.slice(Math.max(0, i - 3), i + 3))}`));
          }
        }

        // at least one race call must show the invalidation actually firing
        // (PEER_GONE) or its direct consequence: re-brokering finding the
        // device briefly absent from deviceMap during the teardown/recreate
        // window, which a restart (a reload) reports as MODULE_RELOADING to
        // a caller with access. Never DEVICE_NOT_FOUND: that would mean the
        // reload's state was recorded too late or cleared too early -- if
        // every race call
        // instead saw DEVICE_INVOKE_FAIL throughout, that would mean the
        // restart hadn't actually started affecting this channel yet by
        // the time the races ran, and the test wouldn't have exercised D4
        // at all.
        const sawChannelDisruption = raceResults.some((r) => {
          return r.code === 'PEER_GONE' || r.code === 'MODULE_RELOADING';
        });
        // What the run saw, for the log: how long the window stayed open.
        const closedAt = raceResults.length > 0 ? raceResults[raceResults.length - 1].at : null;
        console.log(`    [observed] restart window opened ${openedAt != null ? openedAt - requestedAt : '?'} ms after the request and stayed open ${openedAt != null && closedAt != null ? closedAt - openedAt : '?'} ms; ${raceResults.length} calls`);
        if (sawChannelDisruption !== true) {
          return done(new Error(`direct-peer-channels 02 fail: no race call observed PEER_GONE or MODULE_RELOADING in 60 s of calls -- test did not exercise the restart window: ${raceResults.length} calls, codes ${JSON.stringify([...new Set(raceResults.map((r) => r.code))])}`));
        }

        // Finally, wait for the new worker instance to be fully back
        // online and confirm the channel transparently re-established
        // itself against it (D1's "对调用方模块代码完全透明"). Polled, not a
        // single fixed delay -- restart-module's own unload wait is
        // ~4-5s, and the new worker's load (its device registered from
        // the main thread's spec once it has loaded) follows, so the total
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
