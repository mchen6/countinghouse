// C-win-devseg: on Windows a module's path with a segment Windows reads as
// other than its text -- a device name (COM1, NUL.txt, CON .log) or trailing
// dots or spaces (auth.json. opens auth.json there) -- answers ENOENT, as if
// nothing were there, in every mode, before the host is touched, and is
// reported. On POSIX those are names like any other. The rule itself
// (windowsName) is checked on Windows paths on every OS.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker, windowsTrims} = require('../../lib/fs-broker/broker');
const windowsName = (p) => windowsTrims(String(p).split('\\').join('/'));   // (red branch only)
const {mkdtemp} = require('../helpers/test-tmp');

const WIN = process.platform === 'win32';
const NAMES = ['/data/COM1', '/data/nul.txt', '/data/con .log', '/data/a/LPT1.tar.gz', '/data/note.', '/data/note. ', '/data/dir./x'];

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

describe('fs-broker 35: a path Windows reads as other than its text (device names, trailing dots or spaces)', function() {
  this.timeout(60000);

  it('which paths they are, in either separator (on every OS)', () => {
    for (const p of [...NAMES, 'C:\\data\\COM1', 'C:\\x\\con .log', 'M:\\app\\auth.json.']) assert.strictEqual(windowsName(p), true, p);
    for (const p of ['/data/note', '/data/a b/c', '/data/console', '/app', 'C:\\Users\\x', 'M:\\app\\x.json', '/data/.hidden']) assert.strictEqual(windowsName(p), false, p);
  });

  for (const mode of ['off', 'audit', 'enforce']) {
    it(`${WIN ? 'answers ENOENT, touching nothing, reported' : 'are names like any other (POSIX)'}: ${mode}`, async () => {
      const t = await setup(mode);
      try {
        for (const p of NAMES) {
          const rel = p.split('/').slice(2);
          if (WIN) {
            await assert.rejects(t.broker.handle('writeFile', [p, Buffer.from('x'), 'w', 0o666]), (e) => e.code === 'ENOENT', `${mode} ${p}`);
            await assert.rejects(t.broker.handle('stat', [p, {}]), (e) => e.code === 'ENOENT', `${mode} ${p}`);
            assert.ok(t.reports.includes(`win-name ${p}`), t.reports.join(', '));
          } else {
            fs.mkdirSync(path.join(t.dirs.data, ...rel.slice(0, -1)), {recursive: true});
            await t.broker.handle('writeFile', [p, Buffer.from('x'), 'w', 0o666]);
            assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, ...rel), 'utf8'), 'x', `${mode} ${p}`);
          }
        }
        // (on Windows auth.json. would be auth.json: the note under its own
        // name is untouched)
        assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'note'), 'utf8'), 'the note');
      } finally { await t.done(); }
    });
  }
});
