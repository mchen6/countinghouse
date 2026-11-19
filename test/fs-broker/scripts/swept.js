// F4-6: what the patch handles nowhere and holds code, in each shape a
// later Node might add it in, is locked to throw (fail closed), by name,
// and the grant says which; one Node made unchangeable is listed as not
// locked; data is left as it is; a copy of fs still works; nothing swept
// runs under countinghouse's own boot grant either.
module.exports = async (fs, root, ctx) => {
  const fsp = require('fs/promises');
  const outcome = (fn) => { try { const r = fn(); return r != null && typeof(r.then) === 'function' ? 'a promise' : 'ran'; } catch (e) { return e.code || e.name; } };
  // (and it stays locked: an assignment takes, and is wrapped)
  try { fs.fakeAddedSync = () => 'mine'; } catch (e) { /* refused */ }
  ctx.armLate();
  ctx.fillNull();
  ctx.bumpSpace();
  ctx.grow();
  // (module code replacing a global the sweep would read: it reads none)
  const RealMap = globalThis.Map;
  globalThis.Map = function NotMap() {};
  let mapSeen;
  try { mapSeen = typeof(fs.fakeMap) === 'function' ? outcome(() => fs.fakeMap('/etc/hostname')) : `answered ${typeof(fs.fakeMap)}`; } finally { globalThis.Map = RealMap; }
  let helperSaid = null;
  try { fs.FakeReader.helper('/etc/hostname'); } catch (e) { helperSaid = e.message; }
  const release = ctx.handled.grant.boot([root]);
  let underBoot;
  try { underBoot = [outcome(() => fs.fakeHiddenSync('/etc/hostname')), outcome(() => fs.fakeLazySync('/etc/hostname'))]; } finally { release(); }
  return {
    method: outcome(() => fs.fakeAddedSync('/etc/hostname')),
    lazy: outcome(() => fs.fakeLazySync('/etc/hostname')),
    hidden: outcome(() => fs.fakeHiddenSync('/etc/hostname')),
    space: outcome(() => fs.fakeSpace.readSync('/etc/hostname')),
    spaceLive: fs.fakeSpace.version,
    promise: outcome(() => fsp.fakeAdded('/etc/hostname')),
    klass: outcome(() => new fs.FakeReader('/etc/hostname')),
    // (an arrow function's wrapper is no constructor, as the original)
    noCtor: outcome(() => new fs.fakeAddedSync('/etc/hostname')),
    noProto: fs.fakeAddedSync.prototype === undefined && Object.isFrozen(fs.FakeReader.prototype),
    nc: outcome(() => fs.fakeNcSync('/etc/hostname')),
    late: outcome(() => fs.fakeLateSync('/etc/hostname')),
    lateFrozen: Object.isFrozen(fs.fakeLateSync),
    sym: outcome(() => fs[Symbol.for('ch.fakeSym')]('/etc/hostname')),
    replaced: outcome(() => fs.fakeAddedSync()),
    nullFilled: outcome(() => fs.fakeNullSync('/etc/hostname')),
    staticAfter: outcome(() => fs.FakeReader.helper('/etc/hostname')),
    // (a parent's static named as its own export, never the child's)
    helperSaid: /fs\.FakeBase\.helper/.test(String(helperSaid)),
    staticGetter: typeof(fs.FakeReader.hostname) === 'function' ? outcome(() => fs.FakeReader.hostname()) : `answered ${typeof(fs.FakeReader.hostname)}`,
    nodeLazy: outcome(() => fs.fakeNodeLazySync('/etc/hostname')),
    staticName: outcome(() => fs.FakeNamed.name('/etc/hostname')),
    selfNamed: outcome(() => fs.FakeSelfNamed.helper('/etc/hostname')),
    selfNamedName: fs.FakeSelfNamed.name === fs.FakeSelfNamed ? outcome(() => fs.FakeSelfNamed.name.helper('/etc/hostname')) : 'another name',
    copy: outcome(() => Object.assign({}, fs) && ({...fs})),
    asyncOp: outcome(() => fs.fakeAsyncOp('/etc/hostname')),
    // (the wrapper of an async method stays a Function and an Object, with
    // bind, call, apply and toString)
    asyncShape: [fs.fakeAsyncOp instanceof Function, fs.fakeAsyncOp instanceof Object, typeof(fs.fakeAsyncOp.bind), typeof(fs.fakeAsyncOp.call),
      typeof(fs.fakeAsyncOp.apply), typeof(Function.prototype.toString.call(fs.fakeAsyncOp)), outcome(() => fs.fakeAsyncOp.call(null, '/etc/hostname'))],
    constant: fs.fakeConstant,
    ncConst: fs.fakeNcConst,
    data: [fs.fakeData.a, fs.fakeData.list.length],
    // (an array stays an array, an error an error)
    list: [Array.isArray(fs.fakeList), [...fs.fakeList].length, outcome(() => fs.fakeList[0]('/etc/hostname'))],
    err: [fs.fakeErr instanceof Error, String(fs.fakeErr), outcome(() => fs.fakeErr.hook('/etc/hostname'))],
    underBoot,
    cycle: outcome(() => fs.fakeCycle.child.parent.run('/etc/hostname')),
    grown: outcome(() => fs.fakeGrow.open('/etc/hostname')),
    mapSeen,
    lazyNew: outcome(() => new fs.fakeLazySync()),
    // (what the worker throws under enforce, lib/lean-worker.js)
    refusal: ctx.handled.grant.swept.refusal,
    swept: ctx.handled.grant.swept != null && typeof(ctx.handled.grant.swept) === 'object' ? ctx.handled.grant.swept : null
  };
};
