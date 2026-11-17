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
  // the review of #197: the lockdown knows the module's files in every form;
  // /data and /tmp resolved against the cwd; URLs; glob; "type": "module"
  await check('require module is the reduced one', () => Object.isFrozen(require('module')));
  await check('CHUtil.loadFile own file', () => CHUtil.loadFile(path.join(lib, 'sub.js')).sub);
  await check('write path.resolve(/data) then read', () => { const p = path.resolve('/data/r.txt'); fs.writeFileSync(p, 'r'); return fs.readFileSync(p, 'utf8'); });
  await check('write path.resolve(tmpdir) then read', () => { const p = path.resolve(os.tmpdir(), 't2.txt'); fs.writeFileSync(p, 't2'); return fs.readFileSync(p, 'utf8'); });
  await check('readFileSync a file URL of its own', () => fs.readFileSync(new URL('../../lib/data.txt', require('url').pathToFileURL(__filename)), 'utf8'));
  await check('globSync with the default cwd', () => fs.globSync('lib/*.txt'));
  await check('import a "type": "module" package file', async () => (await import('../../lib/esm-pkg/x.js')).typeModule);
  await check('require.resolve.paths are its own', () => require.resolve.paths('anything'));
  // each of the runtime's own files once in this worker's require cache: two
  // spellings of one (an 8.3 short name and its long form) were two
  // instances, one of them never installed (stdio 26)
  await check('runtime files loaded twice', () => {
    const seen = new Map();
    for (const k of Object.keys(require.cache)) {
      // the module's own files (/app, or C:\app on Windows) and dependencies
      if (/^([A-Za-z]:)?[\\/]app[\\/]/.test(k) || /[\\/]node_modules[\\/]/.test(k)) continue;
      const m = /^.*[\\/]lib[\\/](.+\.js)$/.exec(k);
      if (m == null) continue;
      const rel = m[1].replace(/\\/g, '/').toLowerCase();
      seen.set(rel, (seen.get(rel) || 0) + 1);
    }
    return {files: seen.size, twice: [...seen].filter(([, n]) => n > 1).map(([rel]) => rel).sort()};
  });
  return {output: {checks}};
};
