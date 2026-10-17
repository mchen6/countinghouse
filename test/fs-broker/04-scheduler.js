const assert = require('assert');
const {FsScheduler} = require('../../lib/fs-broker/scheduler');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('fs-broker 04: scheduler', () => {
  it('computes the global cap from the threadpool size, at least 1', () => {
    assert.strictEqual(FsScheduler.capFor(16), 12);
    assert.strictEqual(FsScheduler.capFor(4), 3);
    assert.strictEqual(FsScheduler.capFor(1), 1);
    assert.strictEqual(FsScheduler.capFor(0), 1);
  });

  it('never runs more than the global cap at once', async () => {
    const s = new FsScheduler({globalCap: 3});
    let running = 0, peak = 0;
    const task = async () => { running++; peak = Math.max(peak, running); await sleep(10); running--; };
    await Promise.all(Array.from({length: 20}, (_, i) => s.submit(`w${i % 4}`, task)));
    assert.strictEqual(peak, 3);
  });

  it('a single read from a quiet worker does not wait behind a flood', async () => {
    const s = new FsScheduler({globalCap: 3});
    const flood = Array.from({length: 200}, () => s.submit('busy', () => sleep(5)));
    await sleep(1);
    const t0 = Date.now();
    await s.submit('quiet', () => sleep(1));
    assert.ok(Date.now() - t0 < 40, `took ${Date.now() - t0} ms`);
    await Promise.all(flood);
  });

  it('a worker past its queue cap gets EMFILE', async () => {
    const s = new FsScheduler({globalCap: 1, queueCap: 2});
    const block = s.submit('w', () => sleep(20));
    const a = s.submit('w', () => sleep(1));
    const b = s.submit('w', () => sleep(1));
    await assert.rejects(s.submit('w', () => sleep(1)), (e) => e.code === 'EMFILE');
    await Promise.all([block, a, b]);
  });

  it('forget rejects a gone worker\'s queued tasks with EIO', async () => {
    const s = new FsScheduler({globalCap: 1});
    const block = s.submit('w', () => sleep(20));
    const queued = s.submit('w', () => sleep(1));
    s.forget('w');
    await assert.rejects(queued, (e) => e.code === 'EIO');
    await block;
  });
});

const {execFileSync} = require('child_process');
const path = require('path');

// Checks the startup log line (what framework.js set and the cap it derived),
// not the pool libuv actually created: libuv reads the variable itself.
describe('fs-broker 04: threadpool size at startup', function() {
  this.timeout(30000);
  // A missing --modulePolicy file makes startup exit 2 right after the log
  // lines, so no port is bound.
  function startup(extraEnv) {
    const env = Object.assign({}, process.env);
    delete env.UV_THREADPOOL_SIZE;
    Object.assign(env, extraEnv);
    try {
      execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'framework.js'), '--no-workerThread', '--debug',
        '--bindAddr', '127.0.0.1', '--port', '9625', '--modulePolicy', '/nonexistent/policy.json'],
      {env: env, stdio: 'pipe', timeout: 15000});
      return '';
    } catch (e) {
      return String(e.stdout) + String(e.stderr);
    }
  }

  it('defaults UV_THREADPOOL_SIZE to 16 and logs the cap', () => {
    assert.match(startup({}), /up to 12 module file operations in flight \(UV_THREADPOOL_SIZE 16\)/);
  });

  it('keeps an operator-set UV_THREADPOOL_SIZE', () => {
    assert.match(startup({UV_THREADPOOL_SIZE: '4'}), /up to 3 module file operations in flight \(UV_THREADPOOL_SIZE 4\)/);
  });
});
