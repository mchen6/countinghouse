// Exercises the patched fs the way modules and libraries use it.
const path = require('path');

module.exports = async (fs, root, ctx) => {
  const fsp = require('fs/promises');
  const j = (...p) => path.posix.join(root, ...p);
  const out = {};
  fs.writeFileSync(j('a.txt'), 'hello');
  out.readSync = fs.readFileSync(j('a.txt'), 'utf8');
  out.readCb = await new Promise((r, x) => fs.readFile(j('a.txt'), 'utf8', (e, d) => (e ? x(e) : r(d))));
  out.readPromise = await fsp.readFile(j('a.txt'), {encoding: 'utf8'});
  const st = fs.statSync(j('a.txt'));
  out.stats = {isStats: st instanceof fs.Stats, isFile: st.isFile(), size: st.size, mtimeIsDate: st.mtime instanceof Date};
  out.bigint = typeof(fs.statSync(j('a.txt'), {bigint: true}).size);
  const d = fs.readdirSync(root, {withFileTypes: true})[0];
  out.dirent = {isDirent: d instanceof fs.Dirent, name: d.name, isFile: d.isFile(), parentPath: d.parentPath};
  try { fs.readFileSync(j('missing')); } catch (e) { out.missing = {code: e.code, path: e.path, isError: e instanceof Error}; }
  out.fd1 = fs.writeSync(1, 'to stdout\n');
  out.console = ctx.consoleLines.slice();
  await new Promise((r, x) => { const w = fs.createWriteStream(j('s.txt')); w.on('error', x); w.end('streamed', r); });
  out.stream = await new Promise((r, x) => { let s = ''; fs.createReadStream(j('s.txt'), 'utf8').on('data', (c) => { s += c; }).on('end', () => r(s)).on('error', x); });
  const fh = await fsp.open(j('h.txt'), 'w');
  await fh.write('handle');
  await fh.close();
  out.handle = await fsp.readFile(j('h.txt'), 'utf8');
  fs.appendFileSync(j('a.txt'), ' world');
  out.append = fs.readFileSync(j('a.txt'), 'utf8');
  out.exists = [fs.existsSync(j('a.txt')), fs.existsSync(j('nope'))];
  fs.mkdirSync(j('d', 'e'), {recursive: true});
  fs.writeFileSync(j('d', 'e', 'f.txt'), 'deep');
  fs.cpSync(j('d'), j('d2'), {recursive: true});
  out.cp = fs.readFileSync(j('d2', 'e', 'f.txt'), 'utf8');
  out.glob = fs.globSync('**/*.txt', {cwd: root}).sort();
  const dir = fs.opendirSync(root);
  const names = [];
  for await (const e of dir) names.push(e.name);
  out.opendir = names.sort();
  const v = fs.openSync(j('v.bin'), 'w+');
  fs.writevSync(v, [Buffer.from('ab'), Buffer.from('cd')], 0);
  const b1 = Buffer.alloc(2);
  const b2 = Buffer.alloc(2);
  fs.readvSync(v, [b1, b2], 0);
  fs.closeSync(v);
  out.vector = b1.toString() + b2.toString();
  out.realpathNative = fs.realpathSync.native(j('a.txt'));
  out.blob = await (await fs.openAsBlob(j('a.txt'))).text();
  const tmp = fs.mkdtempDisposableSync(j('t-'));
  out.disposable = fs.existsSync(tmp.path);
  tmp.remove();
  try { fs.watch(root); } catch (e) { out.watch = e.code; }
  try { new fs.Utf8Stream({fd: 1}); } catch (e) { out.utf8Stream = e.code; }
  const fh2 = await fsp.open(j('h.txt'), 'r');
  out.fhStream = await new Promise((r, x) => { let s = ''; fh2.createReadStream({encoding: 'utf8'}).on('data', (c) => { s += c; }).on('end', () => r(s)).on('error', x); });
  await fh2.close();
  out.noEntry = fs.statSync(j('missing'), {throwIfNoEntry: false}) === undefined;
  out.fsync1 = fs.fsyncSync(1) === undefined;
  const rfd = fs.openSync(j('a.txt'), 'r');
  out.brokerFd = rfd >= ctx.patch.FD_BASE;
  try { fs.readSync(rfd, Buffer.alloc(2), 0, 5, 0); } catch (e) { out.readRange = e.code; }
  fs.closeSync(rfd);
  out.globAbs = fs.globSync(`${root}/d/**/*.txt`).sort();
  const big = Buffer.alloc(17 * 1024 * 1024, 1);
  fs.writeFileSync(j('big.bin'), big);
  out.bigRead = fs.readFileSync(j('big.bin')).length;
  return out;
};
