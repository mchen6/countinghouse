'use strict';
// MCP completeness M13 (the design, section 8): ctx.ask as a handler has it.
// Server-free, on the main thread, which is how a handler runs in
// single-thread mode: there a call has no token, and its ask context (the
// call's ask state and the action it is of) rides on the call's args under a
// private Symbol, as its billing key does. In a worker ctx.ask sends
// {token, name, values} to the main thread instead (the spawned tests).
const assert = require('assert');
const path = require('path');
const {CountinghouseError} = require('../../lib/countinghouse-error');
const handlerCtx = require('../../lib/handler-ctx');
const questions = require('../../lib/module-questions');
const ask = require('../../lib/module-ask');

const SERVICE = 'urn:countinghouse-test:serviceID:notesService';
const SPEC = require(path.join(__dirname, '..', 'fixtures', 'declares-everything', 'api.json'));
const MODULE = 'declares-everything';
const TEXT = `${MODULE}: Replace the saved note first?`;
const KEY = questions.keyOf({module: MODULE, serviceID: SERVICE, action: 'saveNote', question: 'overwrite', text: TEXT});

describe('questions 03: ctx.ask as a handler has it (MCP completeness M13)', () => {
  // the ctx of one call of saveNote's whose ask state is `state`
  const ctxOf = (state, over = {}) => {
    const args = {input: {id: 'first'}};
    if (state !== undefined) handlerCtx.attachAsk(args, Object.assign({state, module: MODULE, deviceID: 'dev-notes', serviceID: SERVICE, actionName: 'saveNote', spec: SPEC}, over));
    return {ctx: handlerCtx.buildCtx(null, args), args};
  };
  const rejectedWith = async (code, promise) => {
    assert.ok(promise instanceof Promise, 'ctx.ask gives a promise, whatever it is asked');
    await assert.rejects(promise, (e) => e instanceof CountinghouseError && e.code === code, code);
  };

  it('a first pass rejects with ASK_PENDING, the question recorded on the call; the retry\'s pass resolves with the answer', async () => {
    const first = ask.newState({askable: true});
    await rejectedWith('ASK_PENDING', ctxOf(first).ctx.ask('overwrite', {id: 'first'}));
    assert.deepStrictEqual(first.pending, {key: KEY, question: 'overwrite', text: TEXT, schema: '/notesService/saveNote/questions/overwrite',
      asker: {deviceID: 'dev-notes', serviceID: SERVICE, actionName: 'saveNote'}});
    const retry = ask.newState({askable: true, answers: new Map([[KEY, {replace: true}]])});
    assert.deepStrictEqual(await ctxOf(retry).ctx.ask('overwrite', {id: 'first'}), {replace: true});
    const declined = ask.newState({askable: true, answers: new Map([[KEY, null]])});
    assert.strictEqual(await ctxOf(declined).ctx.ask('overwrite', {id: 'first'}), null);
  });

  it('with no one to ask it rejects with ASK_UNAVAILABLE, which a handler may catch to fall back', async () => {
    await rejectedWith('ASK_UNAVAILABLE', ctxOf(undefined).ctx.ask('overwrite', {id: 'first'}));
    await rejectedWith('ASK_UNAVAILABLE', ctxOf(ask.newState({askable: false})).ctx.ask('overwrite', {id: 'first'}));
    const fell = await ctxOf(undefined).ctx.ask('overwrite', {id: 'first'}).catch((e) => (e.code === 'ASK_UNAVAILABLE' ? 'fallback' : 'other'));
    assert.strictEqual(fell, 'fallback');
  });

  it('a misuse is the module\'s error, ASK_NOT_DECLARED, as a rejection and never a throw: no name, an undeclared one, a value that is no text', async () => {
    const state = ask.newState({askable: true});
    const {ctx} = ctxOf(state);
    for (const call of [() => ctx.ask(), () => ctx.ask('other', {}), () => ctx.ask(7), () => ctx.ask('overwrite'), () => ctx.ask('overwrite', {id: {}}), () => ctx.ask('overwrite', {id: () => 'x'}),
      () => ctx.ask('overwrite', {id: Symbol('x')}), () => ctx.ask('overwrite', 'first'), () => ctx.ask('overwrite', {id: 10n})]) {
      await rejectedWith('ASK_NOT_DECLARED', call());
    }
    assert.strictEqual(state.pending, null);
  });

  it('a value\'s getter or toString is never run by the runtime, and an inherited value is not one given', async () => {
    const state = ask.newState({askable: true});
    let ran = 0;
    const tricky = {id: {toString() { ran += 1; return 'first'; }, valueOf() { ran += 1; return 1; }}};
    await rejectedWith('ASK_NOT_DECLARED', ctxOf(state).ctx.ask('overwrite', tricky));
    await rejectedWith('ASK_NOT_DECLARED', ctxOf(state).ctx.ask('overwrite', Object.create({id: 'first'})));
    assert.strictEqual(ran, 0);
  });

  it('the ask context is the call\'s, out of a handler\'s reach: not on ctx, not a key of its args, not in a copy of them', () => {
    const state = ask.newState({askable: true});
    const {ctx, args} = ctxOf(state);
    assert.deepStrictEqual(Object.keys(args), ['input']);
    assert.strictEqual(JSON.stringify(args), '{"input":{"id":"first"}}');
    assert.deepStrictEqual(structuredClone(args), {input: {id: 'first'}});
    for (const k of Object.keys(ctx)) assert.notStrictEqual(ctx[k], state, k);
    assert.strictEqual(typeof(ctx.ask), 'function');
    // and attachAsk takes nothing that is not a context
    for (const junk of [null, 'x', 7, [], undefined]) {
      const a = {input: {}};
      handlerCtx.attachAsk(a, junk);
      assert.deepStrictEqual(Object.getOwnPropertySymbols(a), []);
    }
  });

  // /code-review of M13, 8: a worker's call that was given no token asks no one (never CALL_TOKEN_INVALID,
  // which a module following the docs would not catch)
  it('in a worker, a call with no token has no one to ask: ASK_UNAVAILABLE, with nothing sent', async () => {
    const workerThreads = require('worker_threads');
    const was = Object.getOwnPropertyDescriptor(workerThreads, 'isMainThread');
    Object.defineProperty(workerThreads, 'isMainThread', {value: false, configurable: true, writable: true});
    try {
      await rejectedWith('ASK_UNAVAILABLE', handlerCtx.buildCtx(null, {input: {}}).ask('overwrite', {id: 'first'}));
    } finally {
      Object.defineProperty(workerThreads, 'isMainThread', was);
    }
  });

  it('the action is the context\'s: saveNote\'s question is not readNote\'s', async () => {
    const state = ask.newState({askable: true});
    await rejectedWith('ASK_NOT_DECLARED', ctxOf(state, {actionName: 'readNote'}).ctx.ask('overwrite', {id: 'first'}));
  });
});
