// On Windows a path in a module's own roots with a ":" in a segment names an
// NTFS stream (note:alt, note::$DATA), whose bytes the quota's walk at a
// spawn never sees (lstat and readdir see main streams only): under enforce
// it answers ENOENT, as if nothing were there, before the host is touched,
// and is reported; audit reports it and lets it through; off decides nothing.
// On POSIX ":" is a name's character like any other. The rule itself
// (hasStream) is checked on every OS.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const hasStream = (p) => p.split('/').some((x) => x.includes(':'));   // (red branch only)
const {mkdtemp} = require('../helpers/test-tmp');

const WIN = process.platform === 'win32';
const STREAMS = ['/data/note:alt', '/data/note::$DATA', '/data/a:b/c', '/tmp/x:y'];

async function setup(mode) {
  const base = mkdtemp('broker-streams-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.data, 'note'), 'the note');
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await namespace.prepare();
  const reports = [];
  const broker = new FsBroker({name: 'm', mode, namespace, cwd: '/', report: (rule, target) => reports.push(`${rule} ${target}`)});
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

describe('fs-broker 35: an NTFS stream in a module\'s own roots (Windows)', function() {
  this.timeout(60000);

  it('which paths name one (on every OS)', () => {
    for (const p of STREAMS) assert.strictEqual(hasStream(p), true, p);
    for (const p of ['/data/note', '/data/a b/c', '/app/x.json', '/tmp/a.b/c']) assert.strictEqual(hasStream(p), false, p);
  });

  it(WIN ? 'enforce: a write to a stream answers ENOENT and writes nothing; reported; rm with force finds nothing' : 'enforce: a name with ":" is a name like any other (POSIX)', async () => {
    const t = await setup('enforce');
    try {
      for (const p of STREAMS.filter((x) => !x.includes('/a:b/'))) {
        if (WIN) {
          await assert.rejects(t.broker.handle('writeFile', [p, Buffer.from('x'.repeat(1000)), 'w', 0o666]), (e) => e.code === 'ENOENT', p);
          await assert.rejects(t.broker.handle('readFile', [p, 'r']), (e) => e.code === 'ENOENT', p);
          assert.strictEqual(await t.broker.handle('exists', [p]), false, p);
          await t.broker.handle('rm', [p, {force: true}]);
          await assert.rejects(t.broker.handle('rm', [p, {}]), (e) => e.code === 'ENOENT', `${p}: without force`);
          assert.ok(t.reports.includes(`win-stream ${p}`), t.reports.join(', '));
        } else {
          await t.broker.handle('writeFile', [p, Buffer.from('x'), 'w', 0o666]);
        }
      }
      // (a write to note::$DATA would have been note's own bytes: untouched)
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'note'), 'utf8'), 'the note');
      // (rm with force swallows only this answer: a path outside stays refused)
      await assert.rejects(t.broker.handle('rm', [path.join(t.base, 'elsewhere'), {force: true}]));
    } finally { await t.done(); }
  });

  for (const mode of ['audit', 'off']) {
    it(`${mode}: ${WIN ? (mode === 'audit' ? 'reported and let through' : 'decides nothing') : 'a name like any other (POSIX)'}`, async () => {
      const t = await setup(mode);
      try {
        const got = await t.broker.handle('readFile', ['/data/note::$DATA', 'r']).then((b) => Buffer.from(b).toString(), (e) => e.code);
        if (WIN) {
          assert.strictEqual(got, 'the note', 'note::$DATA is note itself on Windows');
          assert.strictEqual(t.reports.includes('win-stream /data/note::$DATA'), mode === 'audit', t.reports.join(', '));
          // (why enforce refuses it: let through here, a stream's bytes are
          // not what the quota's walk at a spawn measures -- only note's 8)
          if (mode === 'audit') {
            await t.broker.handle('writeFile', ['/data/note:alt', Buffer.alloc(4096, 0x61), 'w', 0o666]);
            const walked = await require('../../lib/fs-broker/spawn-walk').measure([[t.dirs.data, '/data']], {whollyInside: true});
            assert.strictEqual(walked.bytes, 8, `the walk counts ${walked.bytes} bytes, the stream's 4096 not among them`);
          }
        } else {
          assert.strictEqual(got, 'ENOENT', 'POSIX: no file of that name');
        }
      } finally { await t.done(); }
    });
  }
});
