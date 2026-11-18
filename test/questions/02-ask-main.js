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
    assert.deepStrictEqual(state.pending, {key: keyFor(), question: 'overwrite', text: TEXT, schema: '/notesService/saveNote/questions/overwrite',
      asker: {deviceID: 'dev-1', serviceID: SERVICE, actionName: 'saveNote'}, module: MODULE});
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

  it('with no one to ask it is ASK_UNAVAILABLE, and nothing is recorded: a call that may not ask, one with no ask state, an asker with no device', () => {
    const closed = ask.newState({askable: false});
    refusedWith('ASK_UNAVAILABLE', () => ask.answer({token: call(closed), name: 'overwrite', values: {id: 'first'}}, 'w1'));
    assert.strictEqual(closed.pending, null);
    refusedWith('ASK_UNAVAILABLE', () => ask.answer({token: call(null), name: 'overwrite', values: {id: 'first'}}, 'w1'));
    // who asks is known, or no one is asked (a part's ask, through a hop, is test/questions/07: M14)
    const outer = ask.newState({askable: true});
    refusedWith('ASK_UNAVAILABLE', () => ask.answer({token: call(outer, {deviceID: null}), name: 'overwrite', values: {id: 'first'}}, 'w1'));
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

  // F2-3 (the Fable pass over asks): a value is cut to 1000 UTF-16 code units before anything reads it on the main
  // thread (the worker cuts it so, but module code can post __ask itself), and each named value is made once
  describe('an ask\'s values on the main thread (F2-3)', () => {
    const outputLines = require('../../lib/output-lines');
    let cleaned;
    let saved;
    beforeEach(() => {
      cleaned = [];
      saved = outputLines.clean;
      outputLines.clean = (s) => { cleaned.push(String(s).length); return saved(s); };
    });
    afterEach(() => { outputLines.clean = saved; });

    it('a 16 MiB value is cut before it is cleaned, and the dialog says its first 200 characters', () => {
      const state = ask.newState({askable: true});
      const token = call(state);
      const huge = 'x'.repeat(16 * 1024 * 1024);
      refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: huge}}, 'w1'));
      assert.ok(cleaned.length > 0 && Math.max(...cleaned) <= 1000, `nothing over the cut was cleaned (${Math.max(...cleaned)})`);
      assert.ok(state.pending != null && state.pending.text.includes('x'.repeat(200)) && !state.pending.text.includes('x'.repeat(201)), 'the dialog has the first 200');
    });

    it('a value named under many placeholders is made once', () => {
      const message = Array.from({length: 166}, () => '{v}').join(' ');
      const text = questions.composed('m', message, {v: 'y'.repeat(5000)});
      assert.ok(text.length <= 1000, 'the dialog is cut as before');
      // once for the value, once for the module's name (the dialog as it leaves goes through client-text)
      assert.strictEqual(cleaned.length, 2, `cleaned ${cleaned.length} times`);
      assert.ok(Math.max(...cleaned) <= 1000);
    });

    it('a cut never splits a character in two: a pair at the 1000th unit goes whole or not at all', () => {
      const v = `${'a'.repeat(999)}\u{1F600}`;
      const [kept] = Object.values(questions.boundedValues({v}));
      assert.strictEqual(kept, 'a'.repeat(999));
      const text = questions.composed('m', '{v}', {v: `${'\u0001'.repeat(999)}\u{1F600}`});
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), 'no lone high surrogate');
    });

    it('values as the main thread takes them: at most 64, plain ones only, as the worker sends them', () => {
      const many = Object.fromEntries(Array.from({length: 100}, (_, i) => [`k${i}`, i]));
      assert.strictEqual(Object.keys(questions.boundedValues(many)).length, 64);
      assert.deepStrictEqual(Object.assign({}, questions.boundedValues({a: 'x', b: 2, c: true, d: {}, e: NaN, f: null})), {a: 'x', b: 2, c: true, d: null, e: null, f: null});
      assert.deepStrictEqual(Object.assign({}, questions.boundedValues('not an object')), {});
    });
  });

  // (the review of #330: the latest ask is the one pending, so a caught one is never the one shown)
  it('one question a round: a second, different one asked after the first was caught is the one pending', () => {
    const state = ask.newState({askable: true});
    const token = call(state);
    refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: 'first'}}, 'w1'));
    refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: 'second'}}, 'w1'));
    assert.strictEqual(state.pending.text, `${MODULE}: Replace the saved note second?`);
    // asked again as it was, the first is the one pending again
    refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: 'first'}}, 'w1'));
    assert.strictEqual(state.pending.key, keyFor());
  });

  // /code-review of M13, 8: a call's token may name no module (no composition binding yet); the dialog's
  // name is the worker's own module's, as the main thread knows it, and with none there is no one to ask
  it('the dialog names the module the main thread says: the worker\'s own, never "null"', () => {
    const state = ask.newState({askable: true});
    const token = call(state, {module: null});
    refusedWith('ASK_PENDING', () => ask.answer({token, name: 'overwrite', values: {id: 'first'}}, 'w1', SPEC, MODULE));
    assert.strictEqual(state.pending.text, TEXT);
    assert.strictEqual(state.pending.key, keyFor());
    for (const none of [null, undefined, '', 7]) {
      const s = ask.newState({askable: true});
      refusedWith('ASK_UNAVAILABLE', () => ask.decide({state: s, module: none, serviceID: SERVICE, actionName: 'saveNote', spec: SPEC}, 'overwrite', {id: 'first'}));
      assert.strictEqual(s.pending, null);
    }
  });

  it('newState takes only a Map of answers, and a state that is not one asks no one', () => {
    const fresh = {askable: false, answers: new Map(), pending: null, rounds: new Map(), unavailable: new Set(), callRounds: 0, shownAs: null, reachable: null};
    assert.deepStrictEqual(ask.newState(), fresh);
    assert.deepStrictEqual(ask.newState({askable: 'yes', answers: {a: 1}}), fresh);
    // (one with no count of the call's rounds, or one that is no count, is no state: the cap is never skipped)
    const whole = () => Object.assign(ask.newState({askable: true}));
    for (const junk of [{}, {askable: true}, {askable: true, answers: {}}, {askable: true, answers: new Map(), pending: null}, 'x', 7,
      (({callRounds, ...rest}) => rest)(whole()), Object.assign(whole(), {callRounds: -1}), Object.assign(whole(), {callRounds: '0'}), Object.assign(whole(), {callRounds: 0.5})]) {
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
