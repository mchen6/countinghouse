// F4-6: what the patch handles nowhere, in each shape a later Node might
// add it in, is locked to throw (fail closed), by name, and the grant says
// which; one Node made unchangeable is listed as not locked; a copy of fs
// still works; under the boot grant the originals still run.
module.exports = async (fs, root, ctx) => {
  const fsp = require('fs/promises');
  const outcome = (fn) => { try { const r = fn(); return r != null && typeof(r.then) === 'function' ? 'a promise' : 'ran'; } catch (e) { return e.code; } };
  // (and it stays locked: an assignment never takes)
  try { fs.fakeAddedSync = () => 'mine'; } catch (e) { /* refused */ }
  ctx.armLate();
  ctx.fillNull();
  return {
    method: outcome(() => fs.fakeAddedSync('/etc/hostname')),
    lazy: outcome(() => fs.fakeLazySync('/etc/hostname')),
    hidden: outcome(() => fs.fakeHiddenSync('/etc/hostname')),
    space: outcome(() => fs.fakeSpace.readSync('/etc/hostname')),
    promise: outcome(() => fsp.fakeAdded('/etc/hostname')),
    klass: outcome(() => new fs.FakeReader('/etc/hostname')),
    nc: outcome(() => fs.fakeNcSync('/etc/hostname')),
    late: outcome(() => fs.fakeLateSync('/etc/hostname')),
    sym: outcome(() => fs[Symbol.for('ch.fakeSym')]('/etc/hostname')),
    replaced: outcome(() => fs.fakeAddedSync()),
    nullFilled: outcome(() => fs.fakeNullSync('/etc/hostname')),
    staticAfter: outcome(() => fs.FakeReader.helper('/etc/hostname')),
    // (a getter of Node's never runs after the grant: what it answers is a
    // function that throws, never the host's text)
    staticGetter: typeof(fs.FakeReader.hostname) === 'function' ? outcome(() => fs.FakeReader.hostname()) : `answered ${typeof(fs.FakeReader.hostname)}`,
    nodeLazy: outcome(() => fs.fakeNodeLazySync('/etc/hostname')),
    staticName: outcome(() => fs.FakeNamed.name('/etc/hostname')),
    selfNamed: outcome(() => fs.FakeSelfNamed.helper('/etc/hostname')),
    selfNamedName: fs.FakeSelfNamed.name === fs.FakeSelfNamed ? outcome(() => fs.FakeSelfNamed.name.helper('/etc/hostname')) : 'another name',
    bootLazy: ctx.bootLazy === true,
    // (an instance the runtime made under its boot grant keeps working)
    bootInstance: outcome(() => ctx.bootInstance.again(__filename)),
    copy: outcome(() => Object.assign({}, fs) && ({...fs})),
    bootConstructed: ctx.bootConstructed === true,
    swept: ctx.handled.grant.swept != null && typeof(ctx.handled.grant.swept) === 'object' ? ctx.handled.grant.swept : null
  };
};
