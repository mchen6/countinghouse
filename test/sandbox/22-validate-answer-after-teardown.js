// A validation answers only after its teardown: its worker ended, its broker
// idle (bounded) and its throwaway directory removed, and its busy slot
// released. Before, the answer came first and the slot was freed later, so a
// client sending its next validation the moment the first one answered could
// get a spurious "busy" while two were in fact done or nearly done.
//
// In-process and deterministic: the third validation is started inside the
// first one's answer callback, while a slow second one (three seconds to
// require) still holds the other slot. With the slot still counted, that
// third call is refused as busy every time; with the slot released before
// the answer, it runs.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const ROOT  = path.join(__dirname, '..', '..');
const PROBE = path.join(ROOT, 'test', 'fixtures', 'validate-probe');
const SLOW  = path.join(ROOT, 'test', 'fixtures', 'validate-slow');

const options = require('../../lib/cli-options');
require('../../lib/logger').createLogger(false);
let base = null;

function manager() {
  base = fs.mkdtempSync(path.join(os.homedir(), '.ch-validate-22-'));
  options.setOptions({workerThread: true, moduleSandbox: 'audit', moduleDataPath: path.join(base, 'store')});
  const ModuleManager = require('../../lib/module-manager');
  return new ModuleManager();
}

const busy = (r) => r != null && r.ok === false && r.problems.some((p) => /busy/.test(p.message));
const validateDir = () => path.join(base, 'store', '.validate');
const leftovers = () => (fs.existsSync(validateDir()) ? fs.readdirSync(validateDir()) : []);

describe('sandbox 22: a validation answers after its teardown', function() {
  this.timeout(60000);
  // Each case waits for its validations to finish before it ends, so the
  // directory is quiet by the time it is removed.
  afterEach(() => { if (base != null) fs.rmSync(base, {recursive: true, force: true}); base = null; });

  it('a validation started the moment another answers is not refused as busy', (done) => {
    const mm = manager();
    let slowDone = false;
    mm.validateModuleSandboxed(SLOW, 20000, () => { slowDone = true; });
    mm.validateModuleSandboxed(PROBE, 20000, (err, first) => {
      if (err) return done(err);
      try {
        assert.ok(!busy(first), JSON.stringify(first));
        assert.strictEqual(slowDone, false, 'the slow validation should still be running');
      } catch (e) { return done(e); }
      // Only the slow one's throwaway directory may still exist.
      const left = leftovers();
      mm.validateModuleSandboxed(PROBE, 20000, (err2, next) => {
        if (err2) return done(err2);
        let failure = null;
        try {
          assert.ok(!busy(next), `refused as busy: ${JSON.stringify(next)}`);
          assert.strictEqual(left.length, 1, `throwaway directories at the answer: ${JSON.stringify(left)}`);
        } catch (e) { failure = e; }
        const waitSlow = () => (slowDone ? setTimeout(() => done(failure), 500) : setTimeout(waitSlow, 100));
        return waitSlow();
      });
    });
  });

  it('the answer still comes when the broker never goes idle, within the idle bound', function(done) {
    const IDLE_BOUND_MS = require('../../lib/module-lifecycle').IDLE_BOUND_MS;
    this.timeout(IDLE_BOUND_MS + 30000);
    const mm = manager();
    const fsBroker = require('../../lib/fs-broker');
    const original = fsBroker.createForWorker;
    fsBroker.createForWorker = function() {
      // A broker that never goes idle: the teardown waits out the bound.
      return Promise.resolve(original.apply(this, arguments)).then((made) => {
        if (made != null && made.broker != null) made.broker.idle = () => new Promise(() => {});
        return made;
      });
    };
    const started = Date.now();
    mm.validateModuleSandboxed(PROBE, 20000, (err, result) => {
      fsBroker.createForWorker = original;
      if (err) return done(err);
      try {
        assert.ok(result != null && result.module != null, JSON.stringify(result));
        assert.ok(Date.now() - started < IDLE_BOUND_MS + 10000, `answered after ${Date.now() - started} ms`);
        assert.deepStrictEqual(leftovers(), []);
        return done();
      } catch (e) { return done(e); }
    });
  });
});
