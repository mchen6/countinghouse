// One action per way a handler can report success or failure, so
// test/module-loading/08-error-semantics.js can assert each cell of the matrix
// directly. DeviceError is a module-visible global (lib/sandbox.js), the same
// way pre-installed-packages/transform-demo uses it.
const TYPED_CODE = 'DEVICE_OFFLINE';   // any real code; the point is that it survives

module.exports = {
  errService: {
    // deliberate failure, callback style
    callbackTyped: (input, ctx, callback) => callback(new DeviceError(TYPED_CODE), null),

    // the same deliberate failure, async style -- a rejection carrying a typed
    // error. This used to be flattened to DEVICE_INVOKE_EXCEPTION, discarding
    // the code, which left async handlers with no way to report a typed error.
    rejectTyped: async () => { throw new DeviceError(TYPED_CODE); },

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
