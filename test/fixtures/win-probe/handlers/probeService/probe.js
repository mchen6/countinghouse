// Every check of what a module sees of its own files and paths (#195), each
// reported, none stopping the others: one run says all that is wrong.
const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = async () => {
  const checks = [];
  const check = async (name, fn) => {
    try {
      const value = await fn();
      checks.push({name, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value))});
    } catch (e) {
      checks.push({name, ok: false, code: e.code || null, message: String(e.message).slice(0, 400)});
    }
  };
  const lib = path.join(__dirname, '..', '..', 'lib');
  await check('__filename', () => __filename);
  await check('__dirname', () => __dirname);
  await check('process.cwd()', () => process.cwd());
  await check('os.tmpdir()', () => os.tmpdir());
  await check('path.resolve(x)', () => path.resolve('x'));
  await check('require ../../lib/sub', () => require('../../lib/sub'));
  await check('require.resolve ../../lib/sub', () => require.resolve('../../lib/sub'));
  await check('require probe-dep', () => require('probe-dep'));
  await check('import esm', async () => { const m = await import('../../lib/esm.mjs'); return {esm: m.esm, file: m.file}; });
  await check('readFileSync own file via __dirname', () => fs.readFileSync(path.join(lib, 'data.txt'), 'utf8'));
  await check('readdirSync own dir', () => fs.readdirSync(lib).sort());
  await check('statSync own file isFile', () => fs.statSync(path.join(lib, 'data.txt')).isFile());
  await check('promises.readFile own file', () => fs.promises.readFile(path.join(lib, 'data.txt'), 'utf8'));
  await check('existsSync own file', () => fs.existsSync(path.join(lib, 'data.txt')));
  await check('write /data then read', () => { fs.writeFileSync('/data/w.txt', 'w'); return fs.readFileSync('/data/w.txt', 'utf8'); });
  await check('write path.join(/data) then read', () => { const p = path.join('/data', 'j.txt'); fs.writeFileSync(p, 'j'); return fs.readFileSync(p, 'utf8'); });
  await check('write tmpdir then read', () => { const p = path.join(os.tmpdir(), 't.txt'); fs.writeFileSync(p, 't'); return fs.readFileSync(p, 'utf8'); });
  await check('write own file (refused)', () => { fs.writeFileSync(path.join(lib, 'data.txt'), 'x'); return 'written'; });
  await check('read outside (refused)', () => fs.readFileSync(process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname', 'utf8').slice(0, 10));
  await check('stack frame path', () => (new Error('x').stack.split('\n')[1] || '').trim());
  return {output: {checks}};
};
