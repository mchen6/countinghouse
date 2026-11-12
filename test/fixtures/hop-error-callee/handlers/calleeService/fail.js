// The module's own error, returned: a code that is also a catalogue name
// (still the module's), or one of its own. The other kinds try to pass a
// catalogue code off as the runtime's (d2b): by setting `origin`, by
// building the error through its constructor, or by first replacing the
// class's statics (which the sandbox freezes); and one passes on a runtime
// refusal the runtime itself gave it, which stays the runtime's.
module.exports = async (input, ctx) => {
  if (input.kind === 'catalogue') return ctx.error('DEVICE_NOT_FOUND', 'no row 7', {row: 7});
  if (input.kind === 'forgedOrigin') {
    const e = ctx.error('X_FORGED', 'm');
    e.origin = 'runtime';
    e.code = 'MODULE_RELOADING';
    return e;
  }
  if (input.kind === 'forgedConstructor') return new (ctx.error('X_FORGED').constructor)('MODULE_RELOADING');
  if (input.kind === 'patchedStatics') {
    const C = ctx.error('X_FORGED').constructor;
    for (const name of ['answerable', 'replyFields', 'fromModule']) {
      try { C[name] = (e) => e; } catch (patchErr) { /* frozen */ }
    }
    try { Object.defineProperty(C.prototype, 'kind', {get() { return 'runtime'; }}); } catch (patchErr) { /* frozen */ }
    return new C('MODULE_RELOADING');
  }
  if (input.kind === 'passThrough') {
    try {
      await ctx.call('hop-error-callee/calleeService.nowhere', {});
    } catch (e) {
      return e;
    }
  }
  return ctx.error('SHAPE_GONE', 'the shape is gone', {n: 1});
};
