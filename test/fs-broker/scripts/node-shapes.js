// What modules and libraries expect of Node's own fs, run patched and plain
// (fs-broker 36): promisify's shapes, appendFile's flag, copyFile onto the
// same file, rmdir's recursive, cp into a missing parent, statSync's
// throwIfNoEntry, mkdtemp with a trailing separator.
const path = require('path');
const util = require('util');

module.exports = async (fs, root) => {
  const fsp = require('fs/promises');
  const j = (...p) => path.posix.join(root, ...p);
  const step = async (name, fn) => {
    try { return [name, await fn()]; } catch (e) { return [name, `throws ${e.code || e.name}`]; }
  };
  const out = [];
  fs.writeFileSync(j('f.txt'), 'hello');
  // (A3) promisify on the callback forms
  out.push(await step('promisify(exists)', () => util.promisify(fs.exists)(j('f.txt'))));
  out.push(await step('promisify(exists) missing', () => util.promisify(fs.exists)(j('nope'))));
  out.push(await step('promisify(read)', async () => {
    const fd = fs.openSync(j('f.txt'), 'r');
    try {
      const r = await util.promisify(fs.read)(fd, Buffer.alloc(4), 0, 4, 0);
      return {keys: Object.keys(r).sort(), bytesRead: r.bytesRead, text: Buffer.from(r.buffer).toString()};
    } finally { fs.closeSync(fd); }
  }));
  out.push(await step('promisify(write, writev, readv)', async () => {
    const fd = fs.openSync(j('w.txt'), 'w+');
    try {
      const w = await util.promisify(fs.write)(fd, Buffer.from('abc'), 0, 3, 0);
      const ws = await util.promisify(fs.write)(fd, 'de', 3);
      const wv = await util.promisify(fs.writev)(fd, [Buffer.from('x'), Buffer.from('y')], 5);
      const rv = await util.promisify(fs.readv)(fd, [Buffer.alloc(3), Buffer.alloc(4)], 0);
      return {w: [Object.keys(w).sort(), w.bytesWritten], ws: [Object.keys(ws).sort(), ws.bytesWritten, ws.buffer], wv: [Object.keys(wv).sort(), wv.bytesWritten],
        rv: [Object.keys(rv).sort(), rv.bytesRead, Buffer.concat(rv.buffers).toString()]};
    } finally { fs.closeSync(fd); }
  }));
  // (A4) a falsy flag is the default flag: appendFile appends, writeFile truncates
  out.push(await step('appendFile with a falsy flag', async () => {
    fs.writeFileSync(j('log.txt'), 'one\n');
    fs.appendFileSync(j('log.txt'), 'two\n', {flag: undefined});
    await fsp.appendFile(j('log.txt'), 'three\n', {encoding: 'utf8', flag: null});
    await new Promise((res, rej) => fs.appendFile(j('log.txt'), 'four\n', {flag: undefined}, (e) => (e ? rej(e) : res())));
    fs.writeFileSync(j('log2.txt'), 'a long text');
    fs.writeFileSync(j('log2.txt'), 'x', {flag: undefined});
    return [fs.readFileSync(j('log.txt'), 'utf8'), fs.readFileSync(j('log2.txt'), 'utf8')];
  }));
  // (A5) copyFile onto itself or its own hard link changes nothing
  out.push(await step('copyFile onto itself', async () => {
    fs.copyFileSync(j('f.txt'), j('f.txt'));
    await fsp.copyFile(j('f.txt'), j('f.txt'));
    await new Promise((res, rej) => fs.copyFile(j('f.txt'), j('f.txt'), (e) => (e ? rej(e) : res())));
    fs.linkSync(j('f.txt'), j('hl.txt'));
    fs.copyFileSync(j('f.txt'), j('hl.txt'));
    return [fs.readFileSync(j('f.txt'), 'utf8'), fs.readFileSync(j('hl.txt'), 'utf8')];
  }));
  // (A6) rmdir with {recursive: true} still removes a tree
  out.push(await step('rmdir recursive', async () => {
    fs.mkdirSync(j('rr', 'x'), {recursive: true});
    fs.writeFileSync(j('rr', 'x', 'y'), '1');
    fs.rmdirSync(j('rr'), {recursive: true});
    fs.mkdirSync(j('rr2', 'x'), {recursive: true});
    await fsp.rmdir(j('rr2'), {recursive: true});
    fs.mkdirSync(j('rr3', 'x'), {recursive: true});
    await new Promise((res, rej) => fs.rmdir(j('rr3'), {recursive: true}, (e) => (e ? rej(e) : res())));
    return [fs.existsSync(j('rr')), fs.existsSync(j('rr2')), fs.existsSync(j('rr3'))];
  }));
  out.push(await step('rmdir recursive, missing', () => fs.rmdirSync(j('none'), {recursive: true})));
  out.push(await step('rmdir recursive, a file', () => fs.rmdirSync(j('f.txt'), {recursive: true})));
  // (A7) cp of a file makes the destination's parent
  out.push(await step('cp into a missing parent', async () => {
    fs.cpSync(j('f.txt'), j('new', 'deep', 'c.txt'));
    await fsp.cp(j('f.txt'), j('new2', 'deep', 'c.txt'));
    return [fs.readFileSync(j('new', 'deep', 'c.txt'), 'utf8'), fs.readFileSync(j('new2', 'deep', 'c.txt'), 'utf8')];
  }));
  // (A8) statSync's throwIfNoEntry covers ENOTDIR
  out.push(await step('statSync throwIfNoEntry, ENOTDIR', () => fs.statSync(j('f.txt', 'x'), {throwIfNoEntry: false})));
  out.push(await step('lstatSync throwIfNoEntry, ENOTDIR', () => fs.lstatSync(j('f.txt', 'x'), {throwIfNoEntry: false})));
  // (A2) mkdtemp with a trailing separator makes the directory inside
  out.push(await step('mkdtemp(dir + sep)', async () => {
    fs.mkdirSync(j('t'));
    const a = fs.mkdtempSync(`${j('t')}/`);
    const b = await fsp.mkdtemp(`${j('t')}/`);
    const c = fs.mkdtempSync(j('t', 'pre-'));
    return [path.posix.dirname(a) === j('t'), path.posix.dirname(b) === j('t'), path.posix.dirname(c) === j('t') && path.posix.basename(c).startsWith('pre-'), fs.statSync(a).isDirectory()];
  }));
  return out;
};
