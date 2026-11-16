'use strict';
// MCP completeness M13 (the design, section 8): the main thread's answer to a
// handler's ctx.ask. Server-free: real call tokens, the fixture's api.json.
//
// A worker sends {token, name, values} and nothing else of it is read. The
// asking module, service and action are the token entry's (issued by the
// main thread when it sent the call), so a module asks only its own declared
// questions. The call's ask state, made by whoever started the call (the
// gateway), holds the answers this run may use and takes the question that
// has none.
const assert = require('assert');
const path = require('path');
const callTokens = require('../../lib/call-tokens');
const questions = require('../../lib/module-questions');
const ask = require('../../lib/module-ask');

const SERVICE = 'urn:countinghouse-test:serviceID:notesService';
const SPEC = require(path.join(__dirname, '..', 'fixtures', 'declares-everything', 'api.json'));
const MODULE = 'declares-everything';
const TEXT = `${MODULE}: Replace the saved note first?`;
const keyFor = (text = TEXT) => questions.keyOf({module: MODULE, serviceID: SERVICE, action: 'saveNote', question: 'overwrite', text});

describe('questions 02: the main thread\'s answer to ctx.ask (MCP completeness M13)', () => {
  const issued = [];
  // an outer call of saveNote's, sent to worker w1, with this ask state
  const call = (state, over = {}) => {
    const token = callTokens.issue(Object.assign({billingKey: 'k', module: MODULE, workerId: 'w1', deviceID: 'dev-1', serviceID: SERVICE, actionName: 'saveNote', ask: state}, over));
    issued.push(token);
    return token;
  };
  before(() => ask.configure({specOf: (entry) => (entry.module === MODULE ? SPEC : null)}));
  afterEach(() => { for (const t of issued.splice(0)) callTokens.drop(t); });
  after(() => ask.configure());
  const refusedWith = (code, fn) => assert.throws(fn, (e) => e instanceof require('../../lib/countinghouse-error').CountinghouseError && e.code === code, code);

  it('a first pass has no answer: the question is recorded on the call and the handler is ended with ASK_PENDING', () => {
    const state = ask.newState({askable: true});
    const token = call(state);
    refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: 'first'}}, 'w1'));
    assert.deepStrictEqual(state.pending, {key: keyFor(), question: 'overwrite', text: TEXT, schema: '/notesService/saveNote/questions/overwrite'});
  });

  it('on the retry the answer under the question\'s key is given at once: the content, or null for a decline', () => {
    const accepted = ask.newState({askable: true, answers: new Map([[keyFor(), {replace: true, mode: 'append'}]])});
    assert.deepStrictEqual(ask.answer({token: call(accepted), name: 'overwrite', values: {id: 'first'}}, 'w1'), {replace: true, mode: 'append'});
    assert.strictEqual(accepted.pending, null);
    const declined = ask.newState({askable: true, answers: new Map([[keyFor(), null]])});
    assert.strictEqual(ask.answer({token: call(declined), name: 'overwrite', values: {id: 'first'}}, 'w1'), null);
  });

  it('an answer is for the text it was given to: the same question about another note is asked anew', () => {
    const state = ask.newState({askable: true, answers: new Map([[keyFor(), {replace: true}]])});
    const token = call(state);
    refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: 'second'}}, 'w1'));
    assert.strictEqual(state.pending.key, keyFor(`${MODULE}: Replace the saved note second?`));
    assert.strictEqual(state.pending.text, `${MODULE}: Replace the saved note second?`);
  });

  it('what is handed to the handler is its own copy: changing it changes no answer', () => {
    const state = ask.newState({askable: true, answers: new Map([[keyFor(), {replace: true}]])});
    const token = call(state);
    const got = ask.answer({token, name: 'overwrite', values: {id: 'first'}}, 'w1');
    got.replace = false;
    assert.deepStrictEqual(ask.answer({token, name: 'overwrite', values: {id: 'first'}}, 'w1'), {replace: true});
  });

  it('the module, the service and the action are the token\'s: what the message says of them is not read', () => {
    const state = ask.newState({askable: true});
    const token = call(state);
    refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: 'first'}, module: 'other', serviceID: 'urn:x:serviceID:y', actionName: 'readNote', key: 'forged', text: 'Pay now?'}, 'w1'));
    assert.strictEqual(state.pending.text, TEXT);
    assert.strictEqual(state.pending.key, keyFor());
    // and an action asks only its own: readNote declares no "overwrite"
    const other = ask.newState({askable: true});
    refusedWith('ASK_NOT_DECLARED', () => ask.answer({token: call(other, {actionName: 'readNote'}), name: 'overwrite', values: {id: 'first'}}, 'w1'));
    assert.strictEqual(other.pending, null);
  });

  it('a token that is not this worker\'s live call is CALL_TOKEN_INVALID: another worker\'s, an unknown one, a dropped one, none', () => {
    const state = ask.newState({askable: true});
    const token = call(state);
    refusedWith('CALL_TOKEN_INVALID', () => ask.answer({token, name: 'overwrite', values: {id: 'first'}}, 'w2'));
    refusedWith('CALL_TOKEN_INVALID', () => ask.answer({token: 'f'.repeat(32), name: 'overwrite', values: {id: 'first'}}, 'w1'));
    callTokens.drop(token);
    refusedWith('CALL_TOKEN_INVALID', () => ask.answer({token, name: 'overwrite', values: {id: 'first'}}, 'w1'));
    for (const data of [null, undefined, 7, 'x', [], {}, {name: 'overwrite'}, {token: 7, name: 'overwrite'}]) refusedWith('CALL_TOKEN_INVALID', () => ask.answer(data, 'w1'));
    assert.strictEqual(state.pending, null);
  });

  it('with no one to ask it is ASK_UNAVAILABLE, and nothing is recorded: a call that may not ask, one with no ask state, a hop\'s', () => {
    const closed = ask.newState({askable: false});
    refusedWith('ASK_UNAVAILABLE', () => ask.answer({token: call(closed), name: 'overwrite', values: {id: 'first'}}, 'w1'));
    assert.strictEqual(closed.pending, null);
    refusedWith('ASK_UNAVAILABLE', () => ask.answer({token: call(null), name: 'overwrite', values: {id: 'first'}}, 'w1'));
    // a part reached by a hop asks no one yet (M14): its token is a child of the outer call's
    const outer = ask.newState({askable: true});
    const parent = call(outer);
    const child = callTokens.issue({billingKey: 'k', module: MODULE, workerId: 'w1', deviceID: 'dev-1', serviceID: SERVICE, actionName: 'saveNote', parent});
    issued.push(child);
    refusedWith('ASK_UNAVAILABLE', () => ask.answer({token: child, name: 'overwrite', values: {id: 'first'}}, 'w1'));
    assert.strictEqual(outer.pending, null);
    // an answer is never read for a call that may not ask
    const withAnswer = ask.newState({askable: false, answers: new Map([[keyFor(), {replace: true}]])});
    refusedWith('ASK_UNAVAILABLE', () => ask.answer({token: call(withAnswer), name: 'overwrite', values: {id: 'first'}}, 'w1'));
  });

  it('a question the action does not declare, or a value it cannot say, is ASK_NOT_DECLARED, and nothing is recorded', () => {
    const state = ask.newState({askable: true});
    const token = call(state);
    for (const data of [{token, name: 'other', values: {id: 'first'}}, {token, name: 'constructor'}, {token, name: 7}, {token}, {token, name: 'overwrite'}, {token, name: 'overwrite', values: {id: {}}},
      {token, name: 'overwrite', values: 'first'}, {token, name: 'x'.repeat(65), values: {}}]) {
      refusedWith('ASK_NOT_DECLARED', () => ask.answer(data, 'w1'));
    }
    assert.strictEqual(state.pending, null);
    // a module whose spec the main thread does not hold declares nothing
    const unknown = ask.newState({askable: true});
    refusedWith('ASK_NOT_DECLARED', () => ask.answer({token: call(unknown, {module: 'gone'}), name: 'overwrite', values: {id: 'first'}}, 'w1'));
  });

  it('one question a round: a second, different one asked after the first was caught leaves the first pending', () => {
    const state = ask.newState({askable: true});
    const token = call(state);
    refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: 'first'}}, 'w1'));
    refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: 'second'}}, 'w1'));
    assert.strictEqual(state.pending.text, TEXT);
    // asked again as it was, it is still the one pending
    refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: 'first'}}, 'w1'));
    assert.strictEqual(state.pending.key, keyFor());
  });

  it('newState takes only a Map of answers, and a state that is not one asks no one', () => {
    assert.deepStrictEqual(ask.newState(), {askable: false, answers: new Map(), pending: null});
    assert.deepStrictEqual(ask.newState({askable: 'yes', answers: {a: 1}}), {askable: false, answers: new Map(), pending: null});
    for (const junk of [{}, {askable: true}, {askable: true, answers: {}}, 'x', 7]) {
      refusedWith('ASK_UNAVAILABLE', () => ask.answer({token: call(junk), name: 'overwrite', values: {id: 'first'}}, 'w1'));
    }
  });

  it('a token\'s entry carries its call\'s service, action and ask state; a hop\'s carries none of the outer call\'s', () => {
    const state = ask.newState({askable: true});
    const parent = call(state);
    const entry = callTokens.resolve(parent, {workerId: 'w1'});
    assert.deepStrictEqual([entry.serviceID, entry.actionName, entry.ask], [SERVICE, 'saveNote', state]);
    const child = callTokens.issue({billingKey: 'k', module: 'part', workerId: 'w1', deviceID: 'dev-2', parent});
    issued.push(child);
    const hop = callTokens.resolve(child, {workerId: 'w1'});
    assert.deepStrictEqual([hop.serviceID, hop.actionName, hop.ask], [null, null, null]);
  });
});
