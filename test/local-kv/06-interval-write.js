'use strict';
// B-kvflush (release 1, from #484): LocalKv's interval never waits for the
// store lock. Its tick ran the store's synchronous flush(), which sleeps on
// a busy lock up to LOCK_WAIT_MS (2 s) on the main thread. Every change
// already schedules the store's own write (which never waits: a busy lock
// reschedules it), so the tick writes nothing now: it sweeps and reads the
// file again. close() still writes at once, waiting for the lock.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LocalKv = require('../../lib/local-kv');
const tmp = require('../helpers/test-tmp').forFile(['ch-local-kv-06-']);

// a bounded wait on something observable
async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('not seen in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('local-kv 06: the interval never waits for the store lock (B-kvflush)', function() {
  this.timeout(60000);
  const opened = [];
  afterEach(() => { for (const kv of opened.splice(0)) { try { kv.close(); } catch (e) { /* closed */ } } });

  it('a tick never calls the store\'s synchronous flush, which waits for the lock', async () => {
    const dir = tmp.mkdtemp('ch-local-kv-06-');
    const kv = new LocalKv({storePath: dir});
    opened.push(kv);
    // what proves it: the store's waiting write is never what a tick calls
    const flushes = [];
    const realFlush = kv.file.flush;
    kv.file.flush = function() { flushes.push(new Error('called from').stack); return realFlush.apply(this, arguments); };
    let ticks = 0;
    const realSweep = kv.sweep;
    kv.sweep = function() { ticks++; return realSweep.apply(this, arguments); };
    try {
      await new Promise((resolve, reject) => kv.set('k', 'v', (err) => (err ? reject(err) : resolve())));
      // (the first tick is PERSIST_MS, 5 s, after the start)
      await until(() => ticks >= 1);
      assert.deepStrictEqual(flushes, [], 'a tick called the synchronous flush');
      // and the change is written all the same, by the store's own write
      const file = path.join(dir, 'kv.json');
      await until(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).k != null);
    } finally {
      kv.file.flush = realFlush;
      kv.sweep = realSweep;
    }
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
