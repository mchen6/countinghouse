// Discovery ends when every module listed for loading has reported, not after
// a fixed 5 s (reviewer, 2026-11-12; ch-local's acceptance run: pack 1's ten
// modules then waited 5,001 ms after the last had loaded). A handler-map
// module, which is every module in the current format, brings its one device
// online at once on discover, so its discovery is over as soon as that device
// is online. A discovery-style module (its own index.js, which may bring
// devices online over time) keeps today's 5 s hold as the cap. Both thread
// modes.
//
// The local stdio profile: no Redis, no port.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'bin', 'countinghouse-stdio.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

// ms from "module: <name>@... loaded" to "all module discovered".
function discoveryTime(thread, fixture, name) {
  return new Promise((resolve, reject) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ml-17-'));
    const child = spawn(process.execPath, [ENTRY, thread, '--store', 'local', '--storePath', path.join(root, 'store'),
      '--moduleDataPath', path.join(root, 'module_data'), '--modulePath', path.join(root, 'modules'), '--loadModule', path.join(FIXTURES, fixture)],
    {stdio: ['pipe', 'pipe', 'pipe']});
    let err = '';
    let pending = '';
    let loaded = null;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      fs.rmSync(root, {recursive: true, force: true});
      fn(value);
    };
    const timer = setTimeout(() => settle(reject, new Error(`no discovery in 30 s: ${err.slice(-1500)}`)), 30000);
    child.on('error', (e) => settle(reject, e));
    child.on('exit', (code, signal) => settle(reject, new Error(`exited (${code}, ${signal}) before discovery: ${err.slice(-1500)}`)));
    child.stderr.on('data', (d) => {
      err += d;
      // Whole lines only: a log line may span two reads.
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        let j = null;
        try { j = JSON.parse(line); } catch (e) { continue; }
        if (loaded == null && typeof j.msg === 'string' && j.msg.startsWith(`module: ${name}@`) && /loaded$/.test(j.msg)) loaded = Date.parse(j.time);
        if (j.msg === 'all module discovered') return settle(resolve, loaded == null ? null : Date.parse(j.time) - loaded);
      }
    });
  });
}

[['worker mode', '--workerThread'], ['single-thread mode', '--no-workerThread']].forEach(([mode, thread]) => {
  describe(`module-loading 17: discovery ends when the modules have reported, ${mode}`, function() {
    this.timeout(60000);

    it('a handler-map module is discovered as soon as its device is online, well under the 5 s hold', async () => {
      const ms = await discoveryTime(thread, 'usage-scenario', 'usage-scenario');
      assert.ok(ms != null, 'the load was logged');
      assert.ok(ms < 2000, `discovered ${ms} ms after loading`);
    });

    it('a discovery-style module keeps the 5 s hold as its cap', async () => {
      const ms = await discoveryTime(thread, 'dynamic-discovery-module', 'dynamic-discovery-module');
      assert.ok(ms != null, 'the load was logged');
      assert.ok(ms >= 4500, `discovered ${ms} ms after loading`);
    });
  });
});
