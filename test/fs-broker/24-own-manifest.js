// R2-1 Task 4 (spec section 4): a module's own package.json carries its
// countinghouse.calls, so under audit and enforce no write reaches it,
// whichever name the write uses: its /app path, its host path, a symlink, a
// hard link, or a rename onto it. Refused EACCES and recorded as a denial;
// reads go on as before. Server-free: the broker alone (Task 4's re-review,
// LOW-2).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {FsBroker} = require('../../lib/fs-broker/broker');
const {DeniedSet} = require('../../lib/fs-broker/denied');
const {mkdtemp} = require('../helpers/test-tmp');

const MANIFEST = JSON.stringify({name: 'm', countinghouse: {calls: ['a/b.c']}});

async function setup(mode) {
  const base = mkdtemp('broker-manifest-');
  const dirs = {app: path.join(base, 'app'), data: path.join(base, 'data'), tmp: path.join(base, 'tmp'), store: path.join(base, 'store'),
    keys: path.join(base, 'keys')};
  Object.values(dirs).forEach((d) => fs.mkdirSync(d));
  const host = path.join(dirs.app, 'package.json');
  fs.writeFileSync(host, MANIFEST);
  const namespace = createNamespace({moduleRoot: dirs.app, dataDir: dirs.data, tmpDir: dirs.tmp, declared: [], protectedPaths: []});
  await namespace.prepare();
  const reports = [];
  const broker = new FsBroker({name: 'm', mode: mode, namespace: namespace, cwd: '/app',
    report: (rule, target) => reports.push(`${rule} ${target}`), ownManifest: new DeniedSet([host]), pinsDir: path.join(dirs.store, '.pins'),
    denied: new DeniedSet([path.join(dirs.keys, '.identity-secret')])});
  return {base, dirs, host, broker, reports,
    unchanged: () => assert.strictEqual(fs.readFileSync(host, 'utf8'), MANIFEST, 'the manifest was written'),
    done: () => broker.closeAll().then(() => fs.rmSync(base, {recursive: true, force: true}))};
}

const eacces = (e) => e.code === 'EACCES';

['audit', 'enforce'].forEach((mode) => {
  describe(`fs-broker 24: the module's own package.json takes no write (${mode})`, function() {
    this.timeout(10000);
    let t = null;
    beforeEach(async () => { t = await setup(mode); });
    afterEach(() => t.done());

    it('by its /app path: EACCES, recorded as a denial; a read still works', async () => {
      await assert.rejects(t.broker.handle('writeFile', ['/app/package.json', '{}']), eacces);
      assert.ok(t.reports.includes('denied /app/package.json'), t.reports.join(', '));
      assert.strictEqual(String(Buffer.from(await t.broker.handle('readFile', ['/app/package.json']))), MANIFEST);
      t.unchanged();
    });

    it('by its host path: EACCES, recorded as a denial', async () => {
      await assert.rejects(t.broker.handle('writeFile', [t.host, '{}']), eacces);
      assert.ok(t.reports.includes(`denied ${t.host}`), t.reports.join(', '));
      t.unchanged();
    });

    it('through a symlink in /tmp: EACCES', async () => {
      fs.symlinkSync(t.host, path.join(t.dirs.tmp, 'link'));
      await assert.rejects(t.broker.handle('writeFile', ['/tmp/link', '{}']), eacces);
      assert.ok(t.reports.includes('denied /tmp/link'), t.reports.join(', '));
      t.unchanged();
    });

    it('through a hard link in /data: EACCES', async () => {
      fs.linkSync(t.host, path.join(t.dirs.data, 'hard'));
      await assert.rejects(t.broker.handle('writeFile', ['/data/hard', '{}']), eacces);
      await assert.rejects(t.broker.handle('truncate', ['/data/hard', 0]), eacces);
      t.unchanged();
    });

    it('a rename onto it, by either path, or away from it: EACCES', async () => {
      await t.broker.handle('writeFile', ['/data/evil', '{}']);
      await assert.rejects(t.broker.handle('rename', ['/data/evil', '/app/package.json']), eacces);
      await assert.rejects(t.broker.handle('rename', ['/data/evil', t.host]), eacces);
      await assert.rejects(t.broker.handle('rename', ['/app/package.json', '/data/moved']), eacces);
      t.unchanged();
    });

    it('no write reaches the pin records, any module\'s, nor their directory (Task 4\'s last re-review, MED-2)', async () => {
      const pins = path.join(t.dirs.store, '.pins');
      fs.mkdirSync(pins, {recursive: true});
      fs.writeFileSync(path.join(pins, 'm.json'), '{"calls":[]}');
      fs.writeFileSync(path.join(pins, 'm2.json'), '{"calls":[]}');
      await assert.rejects(t.broker.handle('writeFile', [path.join(pins, 'm2.json'), '{"calls":["x/y.z"]}']), eacces);
      await assert.rejects(t.broker.handle('writeFile', [path.join(pins, 'm3.json'), '{"calls":["x/y.z"]}']), eacces);
      await assert.rejects(t.broker.handle('writeFile', [path.join(pins, 'm.json'), '{"calls":["x/y.z"]}']), eacces);
      await assert.rejects(t.broker.handle('unlink', [path.join(pins, 'm.json')]), eacces);
      await assert.rejects(t.broker.handle('rename', [pins, path.join(t.dirs.store, 'gone')]), eacces);
      // through a link in /tmp to the directory
      fs.symlinkSync(pins, path.join(t.dirs.tmp, 'p'));
      await assert.rejects(t.broker.handle('writeFile', ['/tmp/p/m2.json', '{}']), eacces);
      assert.strictEqual(fs.readFileSync(path.join(pins, 'm2.json'), 'utf8'), '{"calls":[]}');
      assert.ok(!fs.existsSync(path.join(pins, 'm3.json')));
    });

    it('no hard link is made to a pin record, so none is written through (the review of the last round)', async () => {
      const pins = path.join(t.dirs.store, '.pins');
      fs.mkdirSync(pins, {recursive: true});
      fs.writeFileSync(path.join(pins, 'm2.json'), '{"calls":[]}');
      const outside = path.join(t.base, 'outside-link');
      await assert.rejects(t.broker.handle('link', [path.join(pins, 'm2.json'), outside]),
        (e) => (mode === 'audit' ? e.code === 'EACCES' : e.code === 'ENOENT' || e.code === 'EACCES'));
      assert.ok(!fs.existsSync(outside), 'the link was made');
      assert.strictEqual(fs.statSync(path.join(pins, 'm2.json')).nlink, 1);
    });

    // #151's final check: renaming <moduleDataPath> away, making a new one
    // and moving the data back passes as outside, and a restart then finds
    // no records (and a new identity secret). No write reaches a directory
    // above the records, the identity secret or the manifest; what is in
    // them is unaffected.
    it('a directory above the pin records, the identity secret or the manifest takes no write', async () => {
      fs.mkdirSync(path.join(t.dirs.store, '.pins'), {recursive: true});
      await assert.rejects(t.broker.handle('rename', [t.dirs.store, `${t.dirs.store}.old`]), eacces);
      await assert.rejects(t.broker.handle('rename', [t.dirs.keys, `${t.dirs.keys}.old`]), eacces);
      await assert.rejects(t.broker.handle('rename', [t.dirs.app, `${t.dirs.app}.old`]), eacces);
      await assert.rejects(t.broker.handle('rename', [t.base, `${t.base}.old`]), eacces);
      await assert.rejects(t.broker.handle('chmod', [t.dirs.store, 0o777]), eacces);
      await assert.rejects(t.broker.handle('rmdir', [t.dirs.keys]), eacces);
      // through a link in /tmp to the directory
      fs.symlinkSync(t.dirs.store, path.join(t.dirs.tmp, 's'));
      await assert.rejects(t.broker.handle('chmod', ['/tmp/s', 0o777]), eacces);
      assert.ok(fs.existsSync(path.join(t.dirs.store, '.pins')) && fs.existsSync(t.dirs.keys) && fs.existsSync(t.host));
      assert.ok(t.reports.includes(`denied ${t.dirs.store}`), t.reports.join(', '));
    });

    if (mode === 'audit') {
      it('what is in those directories is unaffected: a new file beside the records, under audit', async () => {
        await t.broker.handle('writeFile', [path.join(t.dirs.store, 'beside'), 'x']);
        await t.broker.handle('writeFile', [path.join(t.dirs.keys, 'beside'), 'x']);
        assert.strictEqual(fs.readFileSync(path.join(t.dirs.store, 'beside'), 'utf8'), 'x');
      });
    }

    it('a write to any other file is untouched', async () => {
      await t.broker.handle('writeFile', ['/data/ok', 'x']);
      assert.strictEqual(fs.readFileSync(path.join(t.dirs.data, 'ok'), 'utf8'), 'x');
      assert.ok(!t.reports.some((r) => r.startsWith('denied')), t.reports.join(', '));
    });
  });
});
