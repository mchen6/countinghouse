// F4-6: what the patch handles nowhere is locked by one rule, fail closed:
// a primitive passes, anything else answers a function that throws the
// documented code -- whatever its shape, whatever is set there later; a
// slot Node made unchangeable is listed as not locked (the worker refuses
// to start under enforce, naming it); nothing swept runs under
// countinghouse's own boot grant either. 'ran' would be a host read.
module.exports = async (fs, root, ctx) => {
  const fsp = require('fs/promises');
  const outcome = (fn) => { try { const r = fn(); return r != null && typeof(r.then) === 'function' ? 'a promise' : 'ran'; } catch (e) { return e.code || e.name; } };
  try { fs.fakeAddedSync = () => 'mine'; } catch (e) { /* refused */ }
  ctx.armLate();
  ctx.fillNull();
  ctx.grow();
  const heldNs = fs.fakeNs;
  ctx.growNs();
  const release = ctx.handled.grant.boot([root]);
  let underBoot;
  // (a host file outside the namespace, there on every OS: this script)
  const H = __filename;
  try { underBoot = [outcome(() => fs.fakeHiddenSync(H)), outcome(() => fs.fakeLazySync(H))]; } finally { release(); }
  return {
    calls: {
      method: outcome(() => fs.fakeAddedSync(H)), lazy: outcome(() => fs.fakeLazySync(H)), hidden: outcome(() => fs.fakeHiddenSync(H)),
      promise: outcome(() => fsp.fakeAdded(H)), klass: outcome(() => new fs.FakeReader(H)), arrowNew: outcome(() => new fs.fakeAddedSync(H)),
      late: outcome(() => fs.fakeLateSync(H)), sym: outcome(() => fs[Symbol.for('ch.fakeSym')](H)), replaced: outcome(() => fs.fakeAddedSync()),
      nullFilled: outcome(() => fs.fakeNullSync(H)), nodeLazy: outcome(() => fs.fakeNodeLazySync(H)), asyncOp: outcome(() => fs.fakeAsyncOp(H)),
      lazyNew: outcome(() => new fs.fakeLazySync()), space: outcome(() => fs.fakeSpace(H)), map: outcome(() => fs.fakeMap(H)),
      gen: outcome(() => fs.fakeGen(H))
    },
    // (a member of a locked value is none: never the host's)
    members: {
      space: outcome(() => fs.fakeSpace.readSync(H)), staticAfter: outcome(() => fs.FakeReader.helper(H)), staticName: outcome(() => fs.FakeNamed.name(H)),
      selfNamed: outcome(() => fs.FakeSelfNamed.helper(H)), list: outcome(() => fs.fakeList[0](H)), err: outcome(() => fs.fakeErr.hook(H)),
      cycle: outcome(() => fs.fakeCycle.child.parent.run(H)), grown: outcome(() => fs.fakeGrow.open(H)),
      gen: outcome(() => fs.fakeGen.next().value), iter: outcome(() => fs.fakeIter.next().value(H)),
      mapIter: outcome(() => fs.fakeMapIter.next().value(H)), bareMap: outcome(() => Map.prototype.get.call(fs.fakeBareMap, 'r')(H)),
      heldNs: outcome(() => heldNs.open(H)), slotNs: outcome(() => fs.fakeNs.open(H))
    },
    lockedShape: [Object.isFrozen(fs.fakeLateSync), fs.fakeAsyncOp instanceof Function, typeof(fs.fakeAsyncOp.bind), typeof(Function.prototype.toString.call(fs.fakeAsyncOp))],
    copy: outcome(() => Object.assign({}, fs) && ({...fs})),
    primitives: [fs.fakeConstant, fs.fakeNcConst],
    // (unchangeable: not locked, so it runs here; the worker refuses to
    // start under enforce)
    ncLater: (() => { ctx.fillNcLater(); return outcome(() => fs.fakeNcLater(H)); })(),
    underBoot,
    refusal: ctx.handled.grant.swept.refusal,
    swept: ctx.handled.grant.swept
  };
};
