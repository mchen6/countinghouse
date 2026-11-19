// Worker entry for test/helpers/brokered-worker.js: optionally installs the
// fs patch first (as lib/lean-worker.js does), then runs a test script.
const {workerData, parentPort} = require('worker_threads');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib', 'fs-broker');

(async () => {
  const ctx = {consoleLines: []};
  const fh = await require('fs/promises').open(__filename);
  ctx.realFileHandleKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(fh));
  await fh.close();
  ctx.extra = workerData.extra || {};
  // (F4-6: a path-taking method a later Node might add, made before the
  // patch installs, as Node's own would be)
  if (ctx.extra.fakeAdded === true) {
    const fsLib = require('fs');
    const read = fsLib.readFileSync;
    // (each shape a later Node might add one in: a method; a lazy getter, as
    // Utf8Stream is; one not enumerable; a namespace of methods; one Node
    // made unchangeable)
    fsLib.fakeAddedSync = (p) => read(p, 'utf8');
    Object.defineProperty(fsLib, 'fakeLazySync', {get: () => (p) => read(p, 'utf8'), configurable: true, enumerable: true});
    Object.defineProperty(fsLib, 'fakeHiddenSync', {value: (p) => read(p, 'utf8'), configurable: true, enumerable: false, writable: true});
    fsLib.fakeSpace = {readSync: (p) => read(p, 'utf8')};
    Object.defineProperty(fsLib, 'fakeFixedSync', {value: (p) => read(p, 'utf8'), configurable: false, enumerable: true, writable: false});
    // (a class; one writable but not configurable; a lazy getter that
    // answers nothing until later; a symbol's)
    class FakeBase { static helper(p) { return read(p, 'utf8'); } static get hostname() { return read('/etc/hostname', 'utf8'); } }
    fsLib.FakeNamed = class { static name(p) { return read(p, 'utf8'); } };
    // (and one whose name is the class itself, under a slot made writable
    // but not configurable)
    const SelfNamed = class { static helper(p) { return read(p, 'utf8'); } };
    Object.defineProperty(SelfNamed, 'name', {value: SelfNamed});
    fsLib.FakeSelfNamed = SelfNamed;
    // (an async method, whose wrapper stays a Function; a constant, no
    // operation)
    fsLib.fakeAsyncOp = async (p) => read(p, 'utf8');
    fsLib.fakeConstant = 7;
    // (Node's lazy getter: it redefines its own slot on the first read)
    let lazyLoaded;
    // (not enumerable, so no copy of fs reads it before the sweep)
    Object.defineProperty(fsLib, 'fakeNodeLazySync', {configurable: true, enumerable: false, get() {
      if (lazyLoaded === undefined) {
        lazyLoaded = (p) => read(p, 'utf8');
        Object.defineProperty(fsLib, 'fakeNodeLazySync', {value: lazyLoaded, writable: true, configurable: true, enumerable: false});
      }
      return lazyLoaded;
    }});
    fsLib.FakeReader = class FakeReader extends FakeBase { constructor(p) { super(); this.text = read(p, 'utf8'); } again(p) { return read(p, 'utf8'); } };
    // (a slot holding nothing yet, filled later; an unchangeable getter
    // answering nothing yet)
    fsLib.fakeNullSync = null;
    ctx.fillNull = () => { fsLib.fakeNullSync = (p) => read(p, 'utf8'); };
    Object.defineProperty(fsLib, 'fakeFixedGetSync', {get: () => undefined, configurable: false, enumerable: true});
    Object.defineProperty(fsLib, 'fakeNcSync', {value: (p) => read(p, 'utf8'), configurable: false, enumerable: true, writable: true});
    let lateReady = false;
    Object.defineProperty(fsLib, 'fakeLateSync', {get: () => (lateReady ? (p) => read(p, 'utf8') : undefined), configurable: true, enumerable: true});
    ctx.armLate = () => { lateReady = true; };
    fsLib[Symbol.for('ch.fakeSym')] = (p) => read(p, 'utf8');
    require('fs/promises').fakeAdded = async (p) => read(p, 'utf8');
  }
  if (workerData.fsBridge != null) {
    ctx.patch = require(path.join(LIB, 'patch'));
    ctx.handled = ctx.patch.install(require(path.join(LIB, 'client')).createClient(workerData.fsBridge),
      {consoleWrite: (fd, buf) => ctx.consoleLines.push(`${fd}:${Buffer.from(buf).toString()}`)});
  }
  // The script and what it requires load from the repo under a boot grant,
  // as countinghouse's own code does before set-options (lib/lean-worker.js).
  const releaseBoot = ctx.handled != null ? ctx.handled.grant.boot([workerData.repo]) : () => {};
  let run;
  try { run = require(workerData.script); } finally { releaseBoot(); }
  return run(require('fs'), workerData.root, ctx);
})().then((r) => parentPort.postMessage({ok: true, r: r}),
  (e) => parentPort.postMessage({ok: false, e: {code: e && e.code, message: String(e && e.message), stack: String(e && e.stack)}}));
