// The patch installed as on win32 with the virtual drive M (#195), over a
// client that answers as the broker does -- the namespace's POSIX form,
// /app/..., /data/..., /tmp/... -- and, where a broker could, with a path that
// isn't the namespace's (a host-looking one, a name only like a root). Every
// path the module is handed must be in its own spelling, M:\app\...; anything
// else exactly as answered (test/fs-broker/33). Run in a plain worker: the
// patch is installed here, over this client alone.
const path = require('path');

const DIR = 0o40755;
const FILE = 0o100644;

module.exports = async () => {
  const patch = require(path.join(__dirname, '..', '..', '..', 'lib', 'fs-broker', 'patch'));
  const asked = [];
  // (errors made as the broker client makes them, lib/fs-broker/client.js)
  const {toError} = require(path.join(__dirname, '..', '..', '..', 'lib', 'fs-broker', 'client'));
  const enoent = (where) => toError({message: `ENOENT: no such file or directory, open '${where}'`, code: 'ENOENT', errno: -2, syscall: 'open', path: where});
  // (what the broker answers for each request, by its path)
  const answer = (op, args) => {
    const at = String(args[0]);
    // (not push: a check below replaces Array.prototype.push around a call)
    asked[asked.length] = `${op} ${at}`;
    switch (op) {
      case 'realpath':
        if (at.endsWith('/hostlike')) return 'C:\\Users\\someone\\secret';
        if (at.endsWith('/apps')) return '/apps/x';
        if (at.endsWith('/application')) return '/application/x';
        if (at.endsWith('/unc')) return '\\\\server\\share\\x';
        return '/app/handlers/probe';
      case 'mkdtemp': return '/tmp/ch-abc';
      case 'mkdir': return args[1] && args[1].recursive ? '/app/cache' : undefined;
      case 'readlink':
        if (at.endsWith('/abs')) return '/app/vendor/x';
        if (at.endsWith('/rel')) return '../vendor/x';
        return 'C:\\host\\target';
      case 'readdir':
        if (args[1] && args[1].withFileTypes) {
          if (at === '/data/host') return [{name: 'h.js', type: 'file', parentPath: 'C:\\host\\dir'}];
          return [{name: 'a.js', type: 'file', parentPath: at}, {name: 'b.txt', type: 'file', parentPath: at}];
        }
        return at === '/app/src' ? ['keep', 'skip'] : ['a.js'];
      case 'stat':
      case 'lstat':
        return {bigint: false, fields: {mode: at === '/app/src' ? DIR : FILE, size: 0}};
      case 'exists': return at === '/data/there';
      case 'copyFile': case 'rm': case 'unlink': case 'utimes': return null;
      case 'readFile':
        if (at.endsWith('/missing.json')) throw enoent(at);
        if (at.endsWith('/hosterr')) throw enoent('C:\\host\\secret.json');
        if (at.endsWith('/overlap')) throw toError({message: 'z/app/a /app/a /app/a', code: 'EBOOM', path: '/app/a /app/a'});
        if (at.endsWith('/dotdash')) throw toError({message: 'failed /app/x.-tmp', code: 'EBOOM', path: '/app/x'});
        if (at.endsWith('/sentence')) throw Object.assign(new Error('boom at /app/x.json.'), {code: 'EBOOM', path: '/app/x.json'});
        if (at.endsWith('/both')) throw Object.assign(new Error("ENOENT: no such file or directory, open '/app/x' (resolved /app/x)"), {code: 'ENOENT', path: '/app/x'});
        if (at.endsWith('/typed')) throw Object.assign(new TypeError('bad /app/x', {cause: 'why'}), {code: 'ETYPED', path: '/app/x'});
        if (at.endsWith('/caused')) throw Object.assign(new Error("EIO: i/o error, open '/app/x'", {cause: 'why'}), {code: 'EIO', path: '/app/x'});
        if (at.endsWith('/unquoted')) throw Object.assign(new Error('boom at /app/x.json, not /app/x.jsonl'), {code: 'EBOOM', path: '/app/x.json'});
        if (at.endsWith('/two')) {
          throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '/app/a' -> '/data/b'`), {code: 'EXDEV', path: '/app/a', dest: '/data/b'});
        }
        return new Uint8Array(0);
      default: throw new Error(`seen-form client: no ${op}`);
    }
  };
  const client = {sync: (op, args) => answer(op, args), async: async(op, args) => answer(op, args)};
  patch.install(client, {consoleWrite: () => {}, platform: 'win32', virtualDrive: 'M'});
  const fs = require('fs');
  const fsp = require('fs/promises');
  const out = {};
  const caught = (fn) => { try { fn(); return 'no error'; } catch (e) { return {path: e.path, dest: e.dest, message: e.message}; } };
  const caughtAsync = async(fn) => { try { await fn(); return 'no error'; } catch (e) { return {path: e.path, dest: e.dest, message: e.message}; } };

  // realpath, every form
  out.realpathSync = fs.realpathSync('/app/handlers/probe');
  out.realpathSyncNative = fs.realpathSync.native('/app/handlers/probe');
  out.realpathBuffer = fs.realpathSync('/app/handlers/probe', {encoding: 'buffer'}).toString();
  out.realpathCallback = await new Promise((resolve) => fs.realpath('/app/handlers/probe', (e, r) => resolve(e ? e.code : r)));
  out.realpathPromise = await fsp.realpath('/app/handlers/probe');
  // never mapped: a host-looking answer, a name only like a root, a UNC one
  out.realpathHost = fs.realpathSync('/app/hostlike');
  out.realpathApps = fs.realpathSync('/app/apps');
  out.realpathApplication = fs.realpathSync('/app/application');
  out.realpathUnc = fs.realpathSync('/app/unc');
  // the stack's first line says what the message says; a stack formatter the
  // module set is never run by the failing call itself, only when the
  // module reads the stack
  try { fs.readFileSync('/app/missing.json'); } catch (e) { out.errorStackHead = e.stack.split('\n')[0]; }
  {
    const prior = Error.prepareStackTrace;
    let ran = 0;
    Error.prepareStackTrace = (e) => { ran += 1; return `formatted: ${e.message}`; };
    try {
      let caughtError = null;
      try { fs.readFileSync('/app/missing.json'); } catch (e) { caughtError = e; }
      const before = ran;
      out.moduleFormatter = {ranInCall: before, stack: caughtError.stack, ranOnRead: ran - before};
    } finally { Error.prepareStackTrace = prior; }
  }
  out.errorUnquoted = caught(() => fs.readFileSync('/app/unquoted'));
  // (respelling runs in the runtime's error path: module code that replaced
  // what it could -- a pattern's replace and exec, an array's iterator,
  // string split and indexOf, a setter or getter on Object.prototype -- is
  // never run by it, and the error is respelled all the same)
  {
    const saved = {split: String.prototype.split, indexOf: String.prototype.indexOf, replace: String.prototype.replace, iter: Array.prototype[Symbol.iterator],
      reReplace: RegExp.prototype[Symbol.replace], exec: RegExp.prototype.exec, push: Array.prototype.push, replaceAll: String.prototype.replaceAll,
      strReplace: String.prototype[Symbol.replace]};
    let ran = '';
    const trap = (name) => function() { ran += `${name} `; throw new Error(`trap ${name}`); };
    let got = null;
    let gotAsync = null;
    try {
      String.prototype.replaceAll = trap('replaceAll');
      Object.defineProperty(String.prototype, Symbol.replace, {configurable: true, writable: true, value: trap('strReplace')});
      String.prototype.split = trap('split');
      String.prototype.indexOf = trap('indexOf');
      String.prototype.replace = trap('replace');
      Array.prototype[Symbol.iterator] = trap('iterator');
      Array.prototype.push = trap('push');
      RegExp.prototype[Symbol.replace] = trap('reReplace');
      RegExp.prototype.exec = trap('exec');
      Object.defineProperty(Object.prototype, 'dest', {configurable: true, get() { ran += 'dest '; return '/app/planted'; }});
      Object.defineProperty(Object.prototype, 'code', {configurable: true, get() { return undefined; }, set(v) { ran += 'code '; }});
      // (last: any defineProperty after these would read them itself)
      Object.defineProperty(Object.prototype, 'get', {configurable: true, get() { ran += 'get '; return undefined; }});
      Object.defineProperty(Object.prototype, 'set', {configurable: true, get() { ran += 'set '; return undefined; }});
      try { fs.readFileSync('/app/missing.json'); } catch (e) { got = e; }
      // (and the async path)
      try { await fsp.readFile('/app/missing.json'); } catch (e) { gotAsync = e; }
    } finally {
      String.prototype.replaceAll = saved.replaceAll;
      if (saved.strReplace === undefined) delete String.prototype[Symbol.replace]; else String.prototype[Symbol.replace] = saved.strReplace;
      delete Object.prototype.get;
      delete Object.prototype.set;
      String.prototype.split = saved.split;
      String.prototype.indexOf = saved.indexOf;
      String.prototype.replace = saved.replace;
      Array.prototype[Symbol.iterator] = saved.iter;
      Array.prototype.push = saved.push;
      RegExp.prototype[Symbol.replace] = saved.reReplace;
      RegExp.prototype.exec = saved.exec;
      delete Object.prototype.dest;
      delete Object.prototype.code;
    }
    out.replacedIntrinsics = {ran, path: got && got.path, ownDest: got != null && Object.hasOwn(got, 'dest'), code: got && got.code, message: got && got.message,
      asyncPath: gotAsync && gotAsync.path, asyncCode: gotAsync && gotAsync.code};
  }
  // (a Buffer given to opendir: its path a Buffer, in the module's spelling)
  {
    const b = fs.opendirSync(Buffer.from('/app/plugins')).path;
    out.dirBufferPath = [Buffer.isBuffer(b), b.toString()];
  }
  out.errorSentence = caught(() => fs.readFileSync('/app/sentence')).message;
  out.errorOverlap = caught(() => fs.readFileSync('/app/overlap')).message;
  out.errorDotDash = caught(() => fs.readFileSync('/app/dotdash')).message;
  out.errorBoth = caught(() => fs.readFileSync('/app/both')).message;
  try { fs.readFileSync('/app/typed'); } catch (e) { out.errorTyped = [e instanceof TypeError, e.cause, e.path, e.message]; }
  try { fs.readFileSync('/app/caused'); } catch (e) { out.errorCaused = [e.cause, e.code, e.path]; }
  // mkdtemp, mkdir's first directory made, the disposable mkdtemps
  out.mkdtemp = fs.mkdtempSync('/tmp/ch-');
  out.mkdtempPromise = await fsp.mkdtemp('/tmp/ch-');
  out.mkdirRecursive = fs.mkdirSync('/app/cache/a', {recursive: true});
  out.mkdirPromise = await fsp.mkdir('/app/cache/a', {recursive: true});
  out.mkdirPlain = String(fs.mkdirSync('/app/cache/b'));
  out.callbacks = await Promise.all([
    new Promise((resolve) => fs.mkdtemp('/tmp/ch-', (e, r) => resolve(e ? e.code : r))),
    new Promise((resolve) => fs.mkdir('/app/cache/a', {recursive: true}, (e, r) => resolve(e ? e.code : r))),
    new Promise((resolve) => fs.readlink('/app/node_modules/abs', (e, r) => resolve(e ? e.code : r)))
  ]);
  const before = asked.length;
  const disposable = fs.mkdtempDisposableSync('/tmp/ch-');
  out.disposable = disposable.path;
  disposable.remove();
  const asyncDisposable = await fsp.mkdtempDisposable('/tmp/ch-');
  out.asyncDisposable = asyncDisposable.path;
  await asyncDisposable.remove();
  out.disposableRemoves = asked.slice(before).filter((a) => a.startsWith('rm '));
  // readlink: an absolute in-namespace target; a relative one and a host one as they are
  out.readlinkAbs = fs.readlinkSync('/app/node_modules/abs');
  out.readlinkRel = fs.readlinkSync('/app/node_modules/rel');
  out.readlinkHost = fs.readlinkSync('/app/node_modules/host');
  // Dirents' parentPath; a Dir's entries; a Dir's path in the module's spelling; a host-looking parentPath as it is
  const ents = fs.readdirSync('/app/plugins', {withFileTypes: true});
  out.direntParent = ents.map((d) => d.parentPath);
  out.direntPromise = (await fsp.readdir('/app/plugins', {withFileTypes: true})).map((d) => d.parentPath);
  out.direntHost = fs.readdirSync('/data/host', {withFileTypes: true}).map((d) => d.parentPath);
  out.names = fs.readdirSync('/app/plugins');
  out.direntRecursive = fs.readdirSync('/app/plugins', {withFileTypes: true, recursive: true}).map((d) => d.parentPath);
  const dir = fs.opendirSync('/app/plugins');
  out.dirPath = dir.path;
  out.dirEntry = dir.readSync().parentPath;
  dir.closeSync();
  out.dirPromisePath = (await fsp.opendir('/app/plugins')).path;
  out.dirUrl = process.platform === 'win32' ? 'win32' : fs.opendirSync(new URL('file:///app/plugins')).path;
  out.dirBuffer = Buffer.isBuffer(fs.opendirSync(Buffer.from('/app/plugins')).path);
  out.dirCallback = await new Promise((resolve) => fs.opendir('/app/plugins', {recursive: true}, (e, dd) => resolve(e ? e.code : [dd.path, dd.readSync().parentPath])));
  // glob: absolute matches, and Dirents
  out.globSync = fs.globSync('/app/plugins/*.js');
  out.globDirents = fs.globSync('/app/plugins/*.js', {withFileTypes: true}).map((d) => d.parentPath);
  out.globPromise = [];
  for await (const m of fsp.glob('/app/plugins/*.js')) out.globPromise.push(m);
  out.globCallback = await new Promise((resolve) => fs.glob('/app/plugins/*.js', (e, r) => resolve(e ? e.code : r)));
  const excluded = [];
  out.globExclude = fs.globSync('/app/plugins/*', {exclude: (m) => { excluded.push(m); return m === 'M:\\app\\plugins\\b.txt'; }});
  out.globExcludeSaw = excluded;
  // cp's filter: its arguments in the module's spelling; the copies done on the namespace's
  const filtered = [];
  const copyBefore = asked.length;
  fs.cpSync('/app/src', '/data/dst', {recursive: true, filter: (s, d) => { filtered.push([s, d]); return s !== 'M:\\app\\src\\skip'; }});
  out.cpFilter = filtered;
  out.cpCopied = asked.slice(copyBefore).filter((a) => a.startsWith('copyFile '));
  const filteredAsync = [];
  await fsp.cp('/app/src', '/data/dst', {recursive: true, filter: async(s, d) => { filteredAsync.push([s, d]); return true; }});
  out.cpFilterAsync = filteredAsync;
  out.cpError = caught(() => fs.cpSync('/app/src', '/data/dst'));
  out.cpSelf = caught(() => fs.cpSync('/app/src', '/app/src/in', {recursive: true}));
  out.cpExists = caught(() => fs.cpSync('/app/file', '/data/there', {force: false, errorOnExist: true}));
  const filteredCallback = [];
  out.cpCallback = await new Promise((resolve) => fs.cp('/app/file', '/data/new', {filter: (s, dd) => { filteredCallback.push([s, dd]); return false; }}, (e) => resolve(e ? e.code : 'done')));
  out.cpFilterCallback = filteredCallback;
  // errors: path, dest and message; a host-looking path as it is
  out.errorSync = caught(() => fs.readFileSync('/app/missing.json'));
  out.errorCallback = await new Promise((resolve) => fs.readFile('/app/missing.json', (e) => resolve(e ? {path: e.path, message: e.message} : 'no error')));
  out.errorPromise = await caughtAsync(() => fsp.readFile('/app/missing.json'));
  out.errorTwo = caught(() => fs.readFileSync('/app/two'));
  out.errorHost = caught(() => fs.readFileSync('/app/hosterr'));
  // On Windows with the virtual drive in the worker's data (a module
  // worker's), the module's own spelling in: the broker is asked in the
  // namespace's form (askedForeign below) and answers come back in it
  if (process.platform === 'win32' && require('worker_threads').workerData.virtualDrive === 'M') {
    out.own = {
      realpath: fs.realpathSync('M:\\app\\handlers\\probe'),
      glob: fs.globSync('M:/app/plugins/*.js'),
      globExcludeOwn: fs.globSync('M:/app/plugins/*', {exclude: ['M:/app/plugins/b.txt']}),
      globExcludeBackslash: fs.globSync('\\app\\plugins\\*', {exclude: ['\\app\\plugins\\b.txt']}),
      error: caught(() => fs.readFileSync('M:\\app\\missing.json')),
      dir: fs.opendirSync('M:\\app\\plugins').path,
      dirUrl: fs.opendirSync(new URL('file:///M:/app/plugins')).path,
      globBackslash: fs.globSync('\\app\\plugins\\*.js'),
      mkdtemp: fs.mkdtempSync('M:\\tmp\\ch-')
    };
  }
  // what the broker was asked: the namespace's own form throughout
  out.askedForeign = asked.filter((a) => /^[a-zA-Z]+ [A-Z]:/.test(a));
  return out;
};
