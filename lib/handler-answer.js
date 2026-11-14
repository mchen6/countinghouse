// How a module's handler is answered: its output, or its failure as the
// runtime's error and a JSON-safe fault (lean worker step 3, Task 2; moved
// from lib/service.js's doActionCall unchanged, so a lean worker answers
// exactly as a full one did without loading the validator). The caller
// checks the output (`finish`); this decides everything about how the
// handler reported: callback, return, throw or promise, typed or not.
'use strict';

const path = require('path');
const {CountinghouseError, textOf, readGuarded, UNREAD, UNREADABLE_MESSAGE} = require('./countinghouse-error');
// the logger only on a runtime bug, so a lean worker that never meets one
// never loads it (created there if nothing has: the main thread always has)
const LOG = {E: (line) => {
  const logger = require('./logger');
  if (logger.logger == null) logger.createLogger(false);
  return logger.E(line);
}};

// Native Error objects do not survive JSON.stringify -- `.message` and
// `.stack` are non-enumerable own properties, so `res.json({fault: err})`
// silently serializes to `{}`. Verified this was *already* true with the
// old Domain-based catching this function used until 2026-08-09 (the
// domain's 'error' handler received the exact same raw Error object,
// same result) -- initially assumed CI's test027-030 failure was Domain
// losing track of the error (the known fragility from the Sprint 2 nano
// incident), but comparing the
// old and new code side by side against the same environment showed both
// produce an empty fault; this was a latent, pre-existing gap in how a
// caught exception gets shaped for the response, not something Domain
// was ever actually protecting against. Fixed by explicitly normalizing
// the caught error into a plain, JSON-safe object before it becomes
// `fault` (see toJSONSafeFault below), independent of catching mechanism.
// Total: a thrown null, a rejection with nothing, or any non-object is a
// fault too (review of #37: it used to throw, leaving the call unanswered).
// Reading the value never throws either (review of c9: a Proxy whose get
// trap throws used to make fail() throw, so the call was never answered).
// Each field is read on its own and kept as text when present (null and
// undefined stay so), so one throwing getter loses only its own field, and
// the fault is always serialisable, as JSON or over a thread reply
// (reviews of c10 and c11).
// `message` is the one read fail() already made (review of c12: a getter
// runs once), on every path but a runtime bug's, where fromModule read it
// once before it threw (review of c14).
function toJSONSafeFault(err, message) {
  if (err == null || typeof(err) !== 'object') return {message: textOf(err)};
  return {message: (message === UNREAD) ? UNREADABLE_MESSAGE : message,
    name: readField(err, 'name'), stack: readField(err, 'stack')};
}

// One field of a thrown or called-back value, as text (textOf), or
// `fallback` when reading it throws (the error module's guarded read, one
// helper for every reader); never throws itself. fail() calls it with a
// thrown null too.
function readField(err, name, fallback = undefined) {
  const value = (err != null) ? readGuarded(err, name) : undefined;
  if (value === UNREAD) return fallback;
  return (value == null || typeof(value) === 'string') ? value : textOf(value);
}

// A runtime bug's name and where it threw, for the log line; never its
// message, which may carry the module's text. The stack's head is the
// message as it was when the stack was taken, which may since have changed,
// so no line count can skip it (review of c14): the frame is the first line
// that has a frame's exact form and names a file this process has loaded
// (require.cache) under the runtime's root, logged as that file, relative
// to the root, and a line number; a file outside the root (a module's,
// under someone's home directory) is never named (review of c15). A line of
// module text can at most name such a file and a number. The name is logged only when it is one of the language's own
// error names or the runtime's. Never throws.
const RUNTIME_ROOT = path.resolve(__dirname, '..');
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'CountinghouseError']);
const FRAME = /^ {4}at (?:[^\n]*\()?((?:\/|[A-Za-z]:\\)[^():\n]+):(\d{1,7}):\d{1,7}\)?$/;
function whereFrom(err) {
  try {
    if (err == null || typeof(err) !== 'object') return `a thrown ${err === null ? 'null' : typeof(err)}`;
    const name = err.name;
    const named = (typeof(name) === 'string' && ERROR_NAMES.has(name)) ? name : 'an error of another name';
    const stack = err.stack;
    const lines = (typeof(stack) === 'string') ? stack.split('\n') : [];
    for (const line of lines) {
      const frame = FRAME.exec(line);
      if (frame == null || !Object.prototype.hasOwnProperty.call(require.cache, frame[1])) continue;
      const file = path.relative(RUNTIME_ROOT, frame[1]);
      if (file === '' || file.startsWith('..') || path.isAbsolute(file)) continue;
      return `${named} at ${file}:${frame[2]}`;
    }
    return named;
  } catch (readErr) {
    return 'unreadable';
  }
}

// Domain-based catching (Node's deprecated `domain` module) replaced with
// plain try/catch on 2026-08-09, alongside the fault-serialization fix
// above. try/catch has none of domain's dependency-tree fragility, but
// comes with a real, unavoidable capability loss domain's monkey-patching
// used to paper over: try/catch (and `await`) can only catch an exception
// thrown *synchronously relative to where the try/catch is*. It cannot
// catch one thrown later, inside a fully detached callback (e.g. inside a
// bare `setTimeout` in a callback-style action, or inside a `new Promise`
// executor's deferred callback that never calls `resolve`/`reject`) --
// there is no modern, non-deprecated replacement for that specific
// capability short of a much larger AsyncLocalStorage-based
// reimplementation, out of scope for this fix. Two existing tests
// exercise exactly that scenario on purpose
// (test/unit/test029.js/errorInfoTestService/testAsyncThrowInDomain,
// test030.js/testAsyncThrowInAsync -- both throw inside a detached
// setTimeout) and were updated alongside this change: such a call now
// times out (DEVICE_NOT_RESPONDING) rather than returning a fast
// DEVICE_INVOKE_EXCEPTION, an honest behavior change, not an oversight.
// invoke(args, callback): the action's own invoker (a handler's, wrapped
// with its ctx); finish(output): what a successful output is answered with
// (the caller's output check); cb(err, data): the answer.
function answerHandler(invoke, args, cb, finish) {
  let settled = false;

  // Output validation and reply, shared by both styles. Previously the async
  // branch had its own copy which turned *any* validation failure into
  // DEVICE_INVOKE_EXCEPTION, losing the validator's own code; now both report
  // what the validator actually said.
  // A call the main thread had checked has its output checked in a
  // validator, on the reply. A function returned as the whole output is still
  // checked here: it cannot cross between threads, and this keeps its answer (the output
  // argument not found).
  // A reported failure is classified by the *value*, not by how it arrived:
  // a CountinghouseError keeps its own code on either style, so an async
  // handler can finally return a typed error at all (a rejection used to be
  // flattened to DEVICE_INVOKE_EXCEPTION unconditionally, discarding the
  // code).
  //
  // For anything untyped the two styles deliberately still differ, and
  // docs/design-decisions.md records why: `callback(err)` is a handler
  // reporting a failure (DEVICE_INVOKE_FAIL), while a throw is a handler
  // crashing (DEVICE_INVOKE_EXCEPTION). Collapsing those would erase the
  // distinction rather than unify it -- an async function has no way to
  // express the first except by throwing, so the error's type is the only
  // honest signal of which one happened.
  //
  // Typed means §5.1's rule (CountinghouseError.fromModule): a
  // CountinghouseError, or a plain Error whose `.code` is a module's own
  // (not a system error's or Node's).
  const fail = function(err, output, untypedCode) {
    // Building the module's error is the runtime's own code: should it
    // throw (a runtime bug), the call is still answered, as a crash, and
    // the bug is logged by its name and the frame it threw in, never its
    // message, which may carry the module's text (reviews of c11, c12).
    // A typed failure is answered with the runtime's copy of the module's
    // error, never the module's object, which it may still change
    // (CountinghouseError.answerable, review of c14).
    let typed;
    try {
      typed = CountinghouseError.fromModule(err);
      // fromModule's own build (a typed plain Error) is already the
      // runtime's copy; only the module's own object is copied again.
      if (typed != null && typed === err) typed = CountinghouseError.answerable(typed);
    } catch (buildErr) {
      try { LOG.E(`a module's error could not be built (a runtime bug): ${whereFrom(buildErr)}`); } catch (logErr) { /* still answered */ }
      typed = null;
      untypedCode = 'DEVICE_INVOKE_EXCEPTION';
    }
    // The message is read once here, for the error and the fault alike
    // (on the runtime-bug path fromModule had read it already). With
    // none, the catalogue's text alone (getErrorMessage drops empty
    // arguments); an object message is rendered as JSON, as before.
    const message = (typed != null) ? undefined : readField(err, 'message', UNREAD);
    const error = (typed != null) ? typed
                : new CountinghouseError(untypedCode, (message === UNREAD) ? undefined : message);

    if (typed == null && untypedCode === 'DEVICE_INVOKE_EXCEPTION') {
      return cb(error, toJSONSafeFault(err, message));
    }
    //TODO: validate the content of fault object according to its optional fault definition in device spec
    // API's formal fault definition, which can be in either simple or complex type, would make it more conformant to WSDL
    // The output a failure came with is the module's: reading its fault
    // may throw, and then the answer carries none (review of c15).
    let reply = output;
    try {
      if (output && output.fault) reply = output.fault;
    } catch (readErr) {
      reply = null;
    }
    return cb(error, reply);
  };

  let returned;
  try {
    returned = invoke(args, (err, output) => {
      if (settled === true) return;
      settled = true;

      if (err) return fail(err, output, 'DEVICE_INVOKE_FAIL');
      return finish(output);
    });
  } catch (err) {
    // synchronous throw, before the handler ever called back or returned:
    // the same as a rejection, so a plain function may throw its typed
    // error (ctx.error) too, and an untyped throw is still a crash
    if (settled === true) return;
    settled = true;
    return fail(err, null, 'DEVICE_INVOKE_EXCEPTION');
  }

  // A handler may hand back its error by returning it (ctx.error, the
  // user's preferred form), from a plain function or an async one: the same
  // answer as callback(err) or a throw. Only a CountinghouseError counts; a
  // plain object that looks like one is a result. Reading what came back
  // runs the module's own traps and getters (a Proxy's getPrototypeOf, a
  // `then` getter): one that throws is a crash, answered (review of c15).
  // {crashed: thrown} when the read throws, whatever it throws (`false` and
  // `true` included: high review of #37), else true or false.
  const isReturnedError = (value) => {
    try {
      return value instanceof CountinghouseError;
    } catch (readErr) {
      return {crashed: readErr};
    }
  };
  const crashed = (result) => (result !== true && result !== false);

  // (The `then` handlers are attached even once the handler has called
  // back, so a promise it also returned never rejects unhandled.)
  const returnedError = isReturnedError(returned);
  if (crashed(returnedError)) {
    if (settled === true) return;
    settled = true;
    return fail(returnedError.crashed, null, 'DEVICE_INVOKE_EXCEPTION');
  }
  if (returnedError === true) {
    if (settled === true) return;
    settled = true;
    return fail(returned, null, 'DEVICE_INVOKE_FAIL');
  }

  try {
    if (returned == null || typeof(returned.then) !== 'function') return;
    returned.then((output) => {
      if (settled === true) return;
      settled = true;
      const outputError = isReturnedError(output);
      if (crashed(outputError)) return fail(outputError.crashed, null, 'DEVICE_INVOKE_EXCEPTION');
      if (outputError === true) return fail(output, null, 'DEVICE_INVOKE_FAIL');
      return finish(output);
    }, (err) => {
      if (settled === true) return;
      settled = true;
      return fail(err, null, 'DEVICE_INVOKE_EXCEPTION');
    });
  } catch (thenErr) {
    if (settled === true) return;
    settled = true;
    return fail(thenErr, null, 'DEVICE_INVOKE_EXCEPTION');
  }
};

module.exports = {answerHandler, toJSONSafeFault, readField, whereFrom};
