// Restart, backoff and suspend as pure logic, on a fake clock.
const assert = require('assert');
const ModuleSupervisor = require('../../lib/module-supervisor');

function harness() {
  const h = {t: 0, timers: [], restarts: []};
  h.sup = new ModuleSupervisor({
    now: () => h.t,
    setTimer: (fn, ms) => { const timer = {fn: fn, at: h.t + ms, cancelled: false}; h.timers.push(timer); return timer; },
    clearTimer: (timer) => { if (timer != null) timer.cancelled = true; },
    restart: (name, record) => h.restarts.push({name: name, at: h.t, modulePath: record.modulePath})
  });
  h.advance = (ms) => {
    h.t += ms;
    h.timers.filter((x) => !x.cancelled && x.at <= h.t).forEach((x) => { x.cancelled = true; x.fn(); });
  };
  return h;
}

const SPECS = {dev1: {device: {friendlyName: 'm'}}};

describe('sandbox 06: module supervisor', () => {
  it('restarts after 1 s, then 2 s, and suspends on the third exit', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    assert.deepStrictEqual(h.sup.exited('m', 'crash: boom', SPECS), {action: 'restart', delayMs: 1000, at: 1000});
    h.advance(1000);
    assert.deepStrictEqual(h.restarts, [{name: 'm', at: 1000, modulePath: '/m'}]);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    assert.strictEqual(h.sup.exited('m', 'heap limit', SPECS).delayMs, 2000);
    h.advance(2000);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    assert.deepStrictEqual(h.sup.exited('m', 'blocked event loop', SPECS), {action: 'suspend'});
    assert.strictEqual(h.sup.status('m').state, 'suspended');
    h.advance(120000);
    assert.strictEqual(h.restarts.length, 2);
  });

  it('caps the delay at 60 s', () => {
    const h = harness();
    const sup = new ModuleSupervisor({now: () => 0, setTimer: () => null, clearTimer: () => {}, restart: () => {}});
    assert.strictEqual(sup.backoffFor(7), 60000);
    assert.strictEqual(h.sup.backoffFor(1), 1000);
  });

  it('forgets exits older than 10 minutes', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: a', SPECS);
    h.advance(1000);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: b', SPECS);
    h.advance(600001);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    assert.strictEqual(h.sup.exited('m', 'crash: c', SPECS).delayMs, 1000);
  });

  it('answers calls for a restarting or suspended module\'s devices', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: boom', SPECS);
    assert.deepStrictEqual(h.sup.errorForDevice('dev1'),
      {code: 'MODULE_RESTARTING', module: 'm', reason: 'crash: boom', retryAt: 1000});
    assert.deepStrictEqual(h.sup.retainedSpecs(), SPECS);
    assert.strictEqual(h.sup.errorForDevice('other'), null);
  });

  it('clear() cancels a pending restart and resets the history', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: a', SPECS);
    h.sup.clear('m');
    h.advance(5000);
    assert.strictEqual(h.restarts.length, 0);
    assert.strictEqual(h.sup.errorForDevice('dev1'), null);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    assert.strictEqual(h.sup.exited('m', 'crash: b', SPECS).delayMs, 1000);
  });

  it('track() after a restart keeps the history but marks the module running', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: a', SPECS);
    h.advance(1000);
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    const s = h.sup.status('m');
    assert.strictEqual(s.state, 'running');
    assert.strictEqual(s.exits.length, 1);
  });

  it('a second exit before the restart cancels the pending restart timer', () => {
    const h = harness();
    h.sup.track('m', {modulePath: '/m', version: '1.0.0'});
    h.sup.exited('m', 'crash: a', SPECS);
    h.sup.exited('m', 'crash: b', SPECS);
    h.advance(5000);
    assert.strictEqual(h.restarts.length, 1);
  });
});
