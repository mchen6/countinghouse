const path = require('path');

module.exports = async (fs, root) => {
  const fsp = require('fs/promises');
  const j = (...p) => path.posix.join(root, ...p);
  const rel = (p) => (typeof(p) === 'string' && p.startsWith(root) ? `<root>${p.slice(root.length)}` : p);
  const steps = [];
  const step = async(name, fn) => {
    try {
      const v = await fn();
      steps.push([name, 'ok', v === undefined ? null : v]);
    } catch (e) {
      steps.push([name, 'error', e.code || e.message]);
    }
  };
  await step('write', () => fs.writeFileSync(j('f'), 'abc'));
  await step('read', () => fs.readFileSync(j('f'), 'utf8'));
  await step('read missing', () => fs.readFileSync(j('missing')));
  await step('stat size', () => fs.statSync(j('f')).size);
  await step('stat dir', () => fs.statSync(root).isDirectory());
  await step('lstat missing', () => fs.lstatSync(j('nope')));
  await step('mkdir', () => fs.mkdirSync(j('d')));
  await step('mkdir exists', () => fs.mkdirSync(j('d')));
  await step('mkdir -p', () => rel(fs.mkdirSync(j('p', 'q', 'r'), {recursive: true})));
  await step('rmdir not empty', () => fs.rmdirSync(j('p')));
  await step('rm dir no recursive', () => fs.rmSync(j('d')));
  await step('rm -r', () => fs.rmSync(j('p'), {recursive: true}));
  await step('readdir', () => fs.readdirSync(root).sort());
  await step('rename', () => fs.renameSync(j('f'), j('g')));
  await step('rename missing', () => fs.renameSync(j('f'), j('h')));
  await step('copy', () => fs.copyFileSync(j('g'), j('c')));
  await step('copy excl', () => fs.copyFileSync(j('g'), j('c'), fs.constants.COPYFILE_EXCL));
  await step('symlink rel', () => fs.symlinkSync('g', j('l')));
  await step('readlink', () => fs.readlinkSync(j('l')));
  await step('read via link', () => fs.readFileSync(j('l'), 'utf8'));
  await step('link', () => fs.linkSync(j('g'), j('hard')));
  await step('nlink', () => fs.statSync(j('g')).nlink);
  await step('chmod', () => { fs.chmodSync(j('g'), 0o600); return fs.statSync(j('g')).mode & 0o777; });
  await step('truncate', () => { fs.truncateSync(j('g'), 1); return fs.readFileSync(j('g'), 'utf8'); });
  await step('open/write/read', () => {
    const fd = fs.openSync(j('o'), 'w+');
    fs.writeSync(fd, 'xyz');
    const b = Buffer.alloc(3);
    fs.readSync(fd, b, 0, 3, 0);
    fs.closeSync(fd);
    return b.toString();
  });
  // Real fs in a worker warns "File descriptor N closed but not opened in
  // unmanaged mode" for this double close: Node's own warning, expected.
  await step('close twice', () => { const fd = fs.openSync(j('o'), 'r'); fs.closeSync(fd); fs.closeSync(fd); });
  await step('open dir for write', () => fs.openSync(root, 'w'));
  await step('append', () => { fs.appendFileSync(j('o'), '!'); return fs.readFileSync(j('o'), 'utf8'); });
  await step('promises readdir types', async() => (await fsp.readdir(root, {withFileTypes: true})).map((d) => [d.name, d.isFile(), d.isDirectory(), d.isSymbolicLink()]).sort());
  await step('unlink', () => fs.unlinkSync(j('c')));
  await step('unlink missing', () => fs.unlinkSync(j('c')));
  await step('access', () => fs.accessSync(j('g'), fs.constants.R_OK));
  await step('exists', () => [fs.existsSync(j('g')), fs.existsSync(j('c'))]);
  await step('utimes', () => { fs.utimesSync(j('g'), 1000, 2000); return fs.statSync(j('g')).mtimeMs; });
  await step('stat throwIfNoEntry', () => fs.statSync(j('nope'), {throwIfNoEntry: false}) === undefined);
  await step('lstat throwIfNoEntry', () => fs.lstatSync(j('nope'), {throwIfNoEntry: false}) === undefined);
  await step('cp file', () => { fs.cpSync(j('g'), j('cpd')); return fs.readFileSync(j('cpd'), 'utf8'); });
  await step('cp force + errorOnExist overwrites', () => { fs.cpSync(j('o'), j('cpd'), {force: true, errorOnExist: true}); return fs.readFileSync(j('cpd'), 'utf8'); });
  await step('cp without force skips', () => { fs.cpSync(j('g'), j('cpd'), {force: false}); return fs.readFileSync(j('cpd'), 'utf8'); });
  await step('cp without force, errorOnExist', () => fs.cpSync(j('g'), j('cpd'), {force: false, errorOnExist: true}));
  await step('cp into itself', () => { fs.mkdirSync(j('cs')); fs.cpSync(j('cs'), j('cs', 'sub'), {recursive: true}); });
  await step('glob absolute', () => fs.globSync(j('*')).map(rel).sort());
  return steps;
};
