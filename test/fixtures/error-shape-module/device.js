// One action per outcome whose exact response body
// test/mcp-contract/07-error-shape.js pins, on each entry path. A module
// reports its own errors with ctx.error (logger-design §5.1); there are no
// module-visible error classes or globals (step 1 (d2)).
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

    // A handler that reports a typed failure with a plain Error carrying its
    // own code (§5.1's plain-Error rule): the code survives.
    callbackTyped: (input, ctx, callback) => callback(Object.assign(new Error('shape probe'), {code: 'SHAPE_OFFLINE'}), null),

    // The ways a handler hands back its own error (ctx.error): returned
    // from a plain function or an async one, thrown from either, or called
    // back; and a plain Error with a module-style code, thrown. All give the
    // same answer (test/mcp-contract/07).
    returnError: (input, ctx) => ctx.error('SHAPE_REJECTED', 'shape probe'),
    returnErrorAsync: async (input, ctx) => ctx.error('SHAPE_REJECTED', 'shape probe'),
    throwError: async (input, ctx) => { throw ctx.error('SHAPE_REJECTED', 'shape probe'); },
    throwErrorSync: (input, ctx) => { throw ctx.error('SHAPE_REJECTED', 'shape probe'); },
    callbackError: (input, ctx, callback) => callback(ctx.error('SHAPE_REJECTED', 'shape probe'), null),
    throwPlainCoded: async () => { throw Object.assign(new Error('shape probe'), {code: 'SHAPE_REJECTED'}); },

    // Not a module's code (§5.1): a system error's code (it has errno and
    // syscall), and Node's own ERR_ namespace. Both are crashes:
    // DEVICE_INVOKE_EXCEPTION.
    throwSystemCoded: async () => { throw Object.assign(new Error('shape probe'), {code: 'EACCES', errno: -13, syscall: 'open'}); },
    throwNodeCoded: async () => { throw Object.assign(new TypeError('shape probe'), {code: 'ERR_INVALID_ARG_TYPE'}); },
    // A network failure that has a code and no errno, as Node's own 'socket
    // hang up' does: an errno name is never a module's, so it is a crash too.
    throwNetworkCoded: async () => { throw Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'}); },
    // Not an Error at all: thrown null, a rejection with nothing, a thrown
    // plain object that has a code. Each is a crash (DEVICE_INVOKE_EXCEPTION),
    // answered at once.
    throwNull: () => { throw null; },
    rejectEmpty: () => Promise.reject(),
    throwPlainObject: async () => { throw {code: 'SHAPE_REJECTED', message: 'shape probe'}; },
    // Review of c9: a thrown value whose properties throw when read is a
    // crash too, answered at once; an Error with no message gets the
    // catalogue's text alone; a callback failure whose message is an object
    // keeps it in the message, as before.
    throwUnreadable: async () => { throw new Proxy({}, {get() { throw new Error('trap'); }}); },
    throwEmptyMessage: async () => { throw new Error(); },
    callbackObjectMessage: (input, ctx, callback) => callback({message: {reason: 'quota'}}, null),
    // Review of c10: a fault keeps the fields it can read and renders each
    // as text; a message that cannot be rendered still gets an answer; a
    // whitespace-only message is no message.
    throwStackGetterThrows: async () => {
      const e = new Error('db down');
      Object.defineProperty(e, 'stack', {get() { throw new Error('trap'); }});
      throw e;
    },
    throwUnrenderableStack: async () => { throw Object.assign(new Error('x'), {stack: new Proxy({}, {get() { throw new Error('trap'); }})}); },
    callbackCircularMessage: (input, ctx, callback) => { const m = {}; m.self = m; callback({message: m}, null); },
    callbackBlankMessage: (input, ctx, callback) => callback(new Error('   '), null),

    // A plain object that merely looks like an error is a result, not an error.
    returnLookalike: async () => ({code: 'SHAPE_REJECTED', message: 'SHAPE_REJECTED: shape probe'}),

    // The old module-visible globals are gone, in both modes.
    globalsProbe: async () => ({output: {deviceError: typeof DeviceError, chError: typeof CHError}})
  }
};
