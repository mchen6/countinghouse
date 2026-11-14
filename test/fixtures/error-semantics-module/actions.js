// One action per way a handler can report success or failure, so
// test/module-loading/08-error-semantics.js can assert each cell of the matrix
// directly. A typed error is the module's own (ctx.error, logger-design §5.1).
const TYPED_CODE = 'SEMANTICS_TYPED';   // the module's own code; the point is that it survives

module.exports = {
  errService: {
    // deliberate failure, callback style
    callbackTyped: (input, ctx, callback) => callback(ctx.error(TYPED_CODE), null),

    // the same deliberate failure, async style -- a rejection carrying a typed
    // error. This used to be flattened to DEVICE_INVOKE_EXCEPTION, discarding
    // the code, which left async handlers with no way to report a typed error.
    rejectTyped: async (input, ctx) => { throw ctx.error(TYPED_CODE); },

    // untyped failure, reported: "I failed"
    callbackPlain: (input, ctx, callback) => callback(new Error('boom'), null),

    // untyped failure, thrown: "I crashed"
    rejectPlain: async () => { throw new Error('boom'); },

    // NOT an async function, but returns a promise. Under the old
    // `constructor.name === 'AsyncFunction'` check this went down the callback
    // branch, where nothing ever called back, and the call hung until timeout.
    promiseFromPlainFn: () => Promise.resolve({output: {ok: true}}),

    asyncOk: async () => ({output: {ok: true}})
  }
};
