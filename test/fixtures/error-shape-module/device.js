// One action per outcome whose exact response body
// test/mcp-contract/07-error-shape.js pins, on each entry path. DeviceError is
// the module-visible global (lib/sandbox.js) until step 1 (d) of the
// logger-and-errors spec replaces it with ctx.error; that step updates this
// file and the golden together. ctx.error (step 1 (d1)) is the module's own.
module.exports = {
  shapeService: {
    ok: async () => ({output: {ok: true}}),

    // Its input schema requires a string `x`; the runtime rejects a call
    // without it before this handler runs.
    needsInput: async () => ({output: {ok: true}}),

    // A handler that crashes: DEVICE_INVOKE_EXCEPTION, with the error in the fault.
    throwPlain: async () => { throw new Error('boom'); },

    // A handler that reports an untyped failure: DEVICE_INVOKE_FAIL.
    callbackPlain: (input, ctx, callback) => callback(new Error('boom'), null),

    // A handler that reports a typed failure: the code survives.
    callbackTyped: (input, ctx, callback) => callback(new DeviceError('DEVICE_OFFLINE', 'shape probe'), null),

    // The four ways a handler hands back its own error (ctx.error): returned
    // from a plain function or an async one, thrown, or called back. All four
    // give the same answer (test/mcp-contract/07).
    returnError: (input, ctx) => ctx.error('SHAPE_REJECTED', 'shape probe'),
    returnErrorAsync: async (input, ctx) => ctx.error('SHAPE_REJECTED', 'shape probe'),
    throwError: async (input, ctx) => { throw ctx.error('SHAPE_REJECTED', 'shape probe'); },
    callbackError: (input, ctx, callback) => callback(ctx.error('SHAPE_REJECTED', 'shape probe'), null),

    // A plain object that merely looks like an error is a result, not an error.
    returnLookalike: async () => ({topic: 'device error', code: 'SHAPE_REJECTED', message: 'SHAPE_REJECTED: shape probe'})
  }
};
