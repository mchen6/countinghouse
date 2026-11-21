// C-win-devseg: on Windows a namespace path (/app, /data, /tmp) with a
// segment Windows reads as other than its text -- a device name (COM1,
// NUL.txt, CON .log), trailing dots or spaces (note. opens note there), or a
// ":" (an NTFS stream) -- answers ENOENT under enforce, as if nothing were
// there, before the host is touched, and is reported; audit reports it and
// lets it through; off decides nothing about files. On POSIX those are names
// like any other. The rule itself (windowsName) is checked on every OS.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker, windowsTrims} = require('../../lib/fs-broker/broker');
const windowsName = (p) => windowsTrims(p) || p.split('/').some((x) => x.includes(':'));   // (red branch only)
const {mkdtemp} = require('../helpers/test-tmp');

const WIN = process.platform === 'win32';
const NAMES = ['/data/COM1', '/data/nul.txt', '/data/con .log', '/data/a/LPT1.tar.gz', '/data/note.', '/data/note. ', '/data/dir./x', '/data/note::$DATA'];

async function setup(mode) {
  const base = mkdtemp('broker-winnames-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  fs.writeFileSync(path.join(dirs.data, 'note'), 'the note');
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await namespace.prepare();
  const reports = [];
  const broker = new FsBroker({name: 'm', mode, namespace, cwd: '/', report: (rule, target) => reports.push(`${rule} ${target}`)});
  return {base, dirs, broker, reports, done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

describe('fs-broker 35: a namespace path Windows reads as other than its text (device names, trailing dots or spaces, streams)', function() {
  this.timeout(60000);

  it('which namespace paths they are (on every OS)', () => {
    for (const p of NAMES) assert.strictEqual(windowsName(p), true, p);
    for (const p of ['/data/note', '/data/a b/c', '/data/console', '/app', '/app/x.json', '/data/.hidden', '/tmp/a.b/c']) assert.strictEqual(windowsName(p), false, p);
  });

  it(WIN ? 'enforce: each answers ENOENT, touches nothing, is reported; rm with force finds nothing to remove' : 'enforce: each is a name like any other (POSIX)', async () => {
    const t = await setup('enforce');
    try {
      for (const p of NAMES) {
        const rel = p.split('/').slice(2);
        if (WIN) {
          await assert.rejects(t.broker.handle('writeFile', [p, Buffer.from('x'), 'w', 0o666]), (e) => e.code === 'ENOENT', p);
          await assert.rejects(t.broker.handle('stat', [p, {}]), (e) => e.code === 'ENOENT', p);
          assert.strictEqual(await t.broker.handle('exists', [p]), false, p);
          await t.broker.handle('rm', [p, {force: true}]);
          await assert.rejects(t.broker.handle('rm', [p, {}]), (e) => e.code === 'ENOENT', `${p}: without force`);
          assert.ok(t.reports.includes(`win-name ${p}`), t.reports.join(', '));
        } else {
          fs.mkdirSync(path.join(t.dirs.data, ...rel.slice(0, -1)), {recursive: true});
          await t.broker.handle('writeFile', [p, Buffer.from('x'), 'w', 0o666]);
          assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, ...rel), 'utf8'), 'x', p);
        }
      }
      // (a two-path op with such a name second: refused there too; mkdtemp
      // judged by the name it makes, so a prefix like "con" or "build." works)
      if (WIN) await assert.rejects(t.broker.handle('copyFile', ['/data/note', '/data/copy.', 0]), (e) => e.code === 'ENOENT');
      for (const prefix of ['/tmp/con', '/tmp/build.']) assert.ok(typeof(await t.broker.handle('mkdtemp', [prefix])) === 'string', prefix);
      // (rm with force swallows only the Windows rule's own answer: a path
      // outside the namespace stays refused, on every OS)
      await assert.rejects(t.broker.handle('rm', [path.join(t.base, 'elsewhere'), {force: true}]));
      // (on Windows note. would have been note: untouched)
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'note'), 'utf8'), 'the note');
    } finally { await t.done(); }
  });

  for (const mode of ['audit', 'off']) {
    it(`${mode}: ${WIN ? (mode === 'audit' ? 'reported and let through' : 'decides nothing') : 'a name like any other (POSIX)'} (read only: no device is written)`, async () => {
      const t = await setup(mode);
      try {
        // (on Windows "note." is note itself, trimmed by Windows)
        const st = await t.broker.handle('stat', ['/data/note.', {}]).catch((e) => e.code);
        if (WIN) {
          // (note itself, 8 bytes, reached through Windows' trimming)
          assert.ok(st != null && st.fields != null && Number(st.fields.size) === 8, `let through to note: ${JSON.stringify(st)}`);
          assert.strictEqual(t.reports.includes('win-name /data/note.'), mode === 'audit', t.reports.join(', '));
        } else {
          assert.strictEqual(st, 'ENOENT', 'POSIX: no file of that name');
          assert.ok(!t.reports.some((r) => r.startsWith('win-name')), t.reports.join(', '));
        }
      } finally { await t.done(); }
    });
  }
});
