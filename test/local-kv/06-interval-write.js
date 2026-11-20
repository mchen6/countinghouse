'use strict';
// B-kvflush (release 1, from #484): LocalKv's interval write never waits
// for the store lock. Its tick used the store's synchronous flush(), which
// sleeps on a busy lock up to LOCK_WAIT_MS (2 s) on the main thread; it now
// uses the scheduled write (a busy lock reschedules it, backing off), and
// the synchronous flush is kept for close() and the exit flush only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const LocalKv = require('../../lib/local-kv');
const tmp = require('../helpers/test-tmp').forFile(['ch-local-kv-06-']);

const ROOT = path.resolve(__dirname, '..', '..');
const MOD = path.join(ROOT, 'lib', 'store', 'json-file');

// another process holding the store lock for ms, once it has it
function holdLock(dir, ms) {
  const holder = spawn(process.execPath, ['-e', `
    const {withStoreLock} = require(${JSON.stringify(MOD)});
    withStoreLock(${JSON.stringify(dir)}, () => { process.stdout.write('held\\n'); const t = Date.now(); while (Date.now() - t < ${ms}) {} });
  `], {stdio: ['ignore', 'pipe', 'inherit']});
  const exited = new Promise((resolve) => holder.on('exit', resolve));
  return new Promise((resolve) => holder.stdout.once('data', () => resolve({holder, exited})));
}
async function eventually(check, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 25)); }
  return false;
}

describe('local-kv 06: the interval write never waits for the store lock (B-kvflush)', function() {
  this.timeout(60000);
  const opened = [];
  afterEach(() => { for (const kv of opened.splice(0)) { try { kv.close(); } catch (e) { /* closed */ } } });

  it('a tick while another process holds the lock does not stall the event loop, and the write lands after', async () => {
    const dir = tmp.mkdtemp('ch-local-kv-06-');
    const kv = new LocalKv({storePath: dir});
    opened.push(kv);
    // (the first tick is PERSIST_MS, 5 s, after the start: the lock is held
    // across it, longer than LOCK_WAIT_MS)
    const {holder, exited} = await holdLock(dir, 7500);
    try {
      await new Promise((resolve, reject) => kv.set('k', 'v', (err) => (err ? reject(err) : resolve())));
      let last = Date.now();
      let worst = 0;
      const ticker = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 10);
      await new Promise((resolve) => setTimeout(resolve, 6500));
      clearInterval(ticker);
      assert.ok(worst < 1000, `the event loop stalled ${worst} ms while the lock was held (the tick waited for it)`);
    } finally {
      await exited.then(() => undefined, () => undefined);
      if (holder.exitCode == null) holder.kill('SIGKILL');
    }
    const file = path.join(dir, 'kv.json');
    assert.ok(await eventually(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).k != null), 'written once the lock was free');
  });

  it('close() still writes at once, waiting for the lock', () => {
    const dir = tmp.mkdtemp('ch-local-kv-06-');
    const kv = new LocalKv({storePath: dir});
    kv.file.set('k2', {t: 'string', v: 'now'});
    kv.close();
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'kv.json'), 'utf8')).k2.v, 'now');
  });

  tmp.hooks();
});
