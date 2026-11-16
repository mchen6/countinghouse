'use strict';
// MCP completeness M13 (the design, section 8): a call's rounds, as the
// gateway drives them. Server-free: the real request-state mechanics
// (lib/request-state.js), a memory of used nonces, a stand-in for the
// validator's form check.
//
//   begin(...)   before the handler runs: the call's ask state, with what
//                its retry brought (the state verified, used up, and this
//                round's answer checked against the question's form)
//   formOf(...)  after the handler ended with ASK_PENDING: the form for the
//                client and the state its retry must carry
const assert = require('assert');
const crypto = require('crypto');
const {CountinghouseError} = require('../../lib/countinghouse-error');
const requestState = require('../../lib/request-state');
const questions = require('../../lib/module-questions');
const ask = require('../../lib/module-ask');

const SERVICE = 'urn:countinghouse-test:serviceID:notesService';
const MODULE = 'declares-everything';
const FORM = {type: 'object', properties: {replace: {type: 'boolean'}}, required: ['replace']};
const DECLARED = {message: 'Replace the saved note {id}?', schema: '/notesService/saveNote/questions/overwrite'};
const FORMS = {capabilities: {elicitation: {}}};
const textOf = (id) => `${MODULE}: Replace the saved note ${id}?`;
const keyOf = (id) => questions.keyOf({module: MODULE, serviceID: SERVICE, action: 'saveNote', question: 'overwrite', text: textOf(id)});
const CONTEXT = (state) => ({state, module: MODULE, serviceID: SERVICE, actionName: 'saveNote',
  spec: {device: {serviceList: {[SERVICE]: {actionList: [{name: 'saveNote', questions: {overwrite: DECLARED}}]}}}}});

describe('questions 05: a call\'s rounds, as the gateway drives them (MCP completeness M13)', () => {
  const key = crypto.randomBytes(32);
  let used = null;
  let formCalls = null;
  const binding = (over = {}) => Object.assign({caller: 'c_caller', session: 's'.repeat(32), method: 'tools/call', tool: 'notes_save', arguments: {id: 'first', text: 'x'}}, over);
  // the validator's stand-in: the form, and an answer valid when replace is a boolean and nothing else is there
  const form = async (pointer, content) => {
    formCalls.push([pointer, content]);
    if (pointer !== DECLARED.schema) return {schema: null, valid: null};
    return {schema: FORM, valid: content === undefined ? null : (content != null && typeof(content.replace) === 'boolean' && Object.keys(content).length === 1)};
  };
  const deps = (over = {}) => Object.assign({modern: true, questionsOn: true, asks: true, binding: binding(), declared: (name) => (name === 'overwrite' ? DECLARED : null), form, key, used}, FORMS, over);
  const rejectedWith = (code, promise) => assert.rejects(promise, (e) => e instanceof CountinghouseError && e.code === code, code);
  // one pass of a handler that asks about `id`: its ask's outcome
  const asks = (state, id = 'first') => { try { return {answer: ask.decide(CONTEXT(state), 'overwrite', {id})}; } catch (e) { return {code: e.code}; } };
  // a first pass that ends pending, and the form made for it
  const firstForm = async (over = {}) => {
    const state = await ask.begin(deps(over));
    assert.deepStrictEqual(asks(state), {code: 'ASK_PENDING'});
    return ask.formOf(state, deps(over));
  };
  // a pass that asks about the first note again, for the form that follows
  const asksThen = (state) => { asks(state); return state; };
  const retryWith = (made, response, over = {}) => ask.begin(deps(Object.assign({params: {requestState: made.requestState, inputResponses: response === undefined ? undefined : {answer: response}}}, over)));
  beforeEach(() => { used = new requestState.UsedNonces(); formCalls = []; });

  describe('who can be asked', () => {
    it('a modern request that declares form elicitation, with module questions on', async () => {
      assert.strictEqual((await ask.begin(deps())).askable, true);
      assert.strictEqual((await ask.begin(deps({capabilities: {elicitation: {form: {}}}}))).askable, true);
    });

    it('no one else: a legacy request, one that declares no form, questions turned off', async () => {
      for (const over of [{modern: false}, {modern: undefined}, {capabilities: null}, {capabilities: {}}, {capabilities: {elicitation: {url: {}}}}, {capabilities: {sampling: {}}}, {questionsOn: false}]) {
        assert.strictEqual((await ask.begin(deps(over))).askable, false, JSON.stringify(over));
      }
    });

    it('a state presented where no one can be asked is not read, and not used up', async () => {
      const made = await firstForm();
      const state = await retryWith(made, {action: 'accept', content: {replace: true}}, {modern: false});
      assert.strictEqual(state.askable, false);
      assert.strictEqual(state.answers.size, 0);
      // it is still good for the retry it was made for
      assert.deepStrictEqual(asks(await retryWith(made, {action: 'accept', content: {replace: true}})), {answer: {replace: true}});
    });
  });

  describe('the form', () => {
    it('is one elicitation, a form: the composed text and the question\'s schema, with a state bound to this call', async () => {
      const made = await firstForm();
      assert.deepStrictEqual(made.inputRequests, {answer: {method: 'elicitation/create', params: {mode: 'form', message: textOf('first'), requestedSchema: FORM}}});
      // and its round, for the call's usage record
      assert.strictEqual(made.round, 1);
      const verified = requestState.verify(key, made.requestState, binding());
      assert.strictEqual(verified.ok, true);
      assert.deepStrictEqual([verified.question, verified.round, verified.answers], [`${keyOf('first')}:overwrite`, 1, {}]);
    });

    it('with no form to show (the validators have none, did not run, or timed out), or no pending question, there is no one to ask', async () => {
      const state = await ask.begin(deps());
      asks(state);
      for (const bad of [async () => null, async () => ({schema: null, valid: null}), async () => ({failed: 'Error'}), async () => ({timeout: new Error('late')}), async () => { throw new Error('gone'); }]) {
        await rejectedWith('ASK_UNAVAILABLE', ask.formOf(state, deps({form: bad})));
      }
      await rejectedWith('ASK_UNAVAILABLE', ask.formOf(await ask.begin(deps()), deps()));
    });

    it('a state that cannot be made (the earlier answers past their bound) is "no one to ask", never an error of its own', async () => {
      const state = await ask.begin(deps());
      for (let i = 0; i < 40; i++) state.answers.set(crypto.randomBytes(32).toString('base64url'), {note: 'n'.repeat(250)});
      asks(state);
      await rejectedWith('ASK_UNAVAILABLE', ask.formOf(state, deps()));
    });
  });

  describe('the retry', () => {
    it('an accepted answer that fits the form is the answer: the handler\'s next pass gets it at once', async () => {
      const made = await firstForm();
      const state = await retryWith(made, {action: 'accept', content: {replace: true}});
      assert.deepStrictEqual(asks(state), {answer: {replace: true}});
      assert.deepStrictEqual(formCalls.pop(), [DECLARED.schema, {replace: true}], 'checked against the question\'s own form');
    });

    it('a decline and a cancel are an answer too: null', async () => {
      for (const action of ['decline', 'cancel']) {
        const state = await retryWith(await firstForm(), {action});
        assert.deepStrictEqual(asks(state), {answer: null}, action);
      }
    });

    it('a state is used once: the same retry again is refused', async () => {
      const made = await firstForm();
      await retryWith(made, {action: 'accept', content: {replace: true}});
      await rejectedWith('ASK_STATE_INVALID', retryWith(made, {action: 'accept', content: {replace: true}}));
    });

    it('a state is for the caller, the session, the tool and the arguments it was made for, and for five minutes: one refusal and one text for all of it', async () => {
      const made = await firstForm();
      const texts = new Set();
      const refused = async (over) => {
        const e = await retryWith(made, {action: 'accept', content: {replace: true}}, over).then(() => null, (err) => err);
        assert.ok(e instanceof CountinghouseError && e.code === 'ASK_STATE_INVALID', JSON.stringify(over).slice(0, 80));
        texts.add(e.message);
      };
      await refused({binding: binding({caller: 'c_other'})});
      await refused({binding: binding({session: 't'.repeat(32)})});
      await refused({binding: binding({session: ''})});
      await refused({binding: binding({tool: 'notes_read'})});
      await refused({binding: binding({method: 'tools/list'})});
      await refused({binding: binding({arguments: {id: 'second', text: 'x'}})});
      await refused({now: Date.now() + 6 * 60 * 1000});
      await refused({key: crypto.randomBytes(32)});
      for (const junk of ['', 'v1.x.y', 7, null, {}, `${made.requestState}x`]) {
        const e = await ask.begin(deps({params: {requestState: junk, inputResponses: {answer: {action: 'accept', content: {replace: true}}}}})).then(() => null, (err) => err);
        assert.ok(e instanceof CountinghouseError && e.code === 'ASK_STATE_INVALID', JSON.stringify(junk));
        texts.add(e.message);
      }
      // used once, it reads the same too
      await retryWith(made, {action: 'decline'});
      await refused({});
      assert.strictEqual(texts.size, 1, [...texts].join(' | '));
    });

    it('a store that cannot say whether the state was used is a refusal of its own, retryable, and never "used"', async () => {
      const made = await firstForm();
      for (const broken of [{use: async () => { throw Object.assign(new Error('late'), {code: 'USED_NONCE_TIMEOUT'}); }}, {use: () => { throw new Error('down'); }}]) {
        const e = await retryWith(made, {action: 'accept', content: {replace: true}}, {used: broken}).then(() => null, (err) => err);
        assert.ok(e instanceof CountinghouseError && e.code === 'ASK_STATE_UNCHECKED', String(e && e.code));
        assert.strictEqual(e.retryable, true);
        // The reviewer's (c) on #311: a store that timed out may still have recorded the state as used,
        // so the text does not promise the same retry will be taken
        assert.match(e.message, /may no longer be usable/);
        assert.doesNotMatch(e.message, /send the same retry again\.$/);
      }
      // here the store recorded nothing, so the same retry, with the store back, is taken
      assert.deepStrictEqual(asks(await retryWith(made, {action: 'accept', content: {replace: true}})), {answer: {replace: true}});
      // and where a store that timed out did record it, the retry is refused as used: the caller asks again
      const late = await firstForm();
      const real = used;
      const lands = {use: async (...a) => { await real.use(...a); throw Object.assign(new Error('late'), {code: 'USED_NONCE_TIMEOUT'}); }};
      await rejectedWith('ASK_STATE_UNCHECKED', retryWith(late, {action: 'accept', content: {replace: true}}, {used: lands}));
      await rejectedWith('ASK_STATE_INVALID', retryWith(late, {action: 'accept', content: {replace: true}}));
      // and a store that answers anything but a plain true is "used"
      const made2 = await firstForm();
      await rejectedWith('ASK_STATE_INVALID', retryWith(made2, {action: 'accept', content: {replace: true}}, {used: {use: async () => 'yes'}}));
    });

    // The reviewer's (a) on #311: what a made state is bound to is a copy of the arguments, kept apart from
    // the object a handler is given; only a call that can end on a question needs one
    it('the arguments a state is bound to are a copy, made only for a call that can be asked and whose action declares a question', async () => {
      const args = {id: 'first', nested: {text: 'x'}};
      const askable = ask.newState({askable: true});
      const copy = ask.bindingArguments({state: askable, asks: true, arguments: args});
      assert.deepStrictEqual(copy, args);
      assert.ok(copy !== args && copy.nested !== args.nested, 'a copy all the way down');
      // nothing to bind: the same object, no copy made
      assert.strictEqual(ask.bindingArguments({state: askable, asks: false, arguments: args}), args, 'the action declares no question');
      assert.strictEqual(ask.bindingArguments({state: ask.newState({askable: false}), asks: true, arguments: args}), args, 'no one to ask');
      assert.strictEqual(ask.bindingArguments({state: null, asks: true, arguments: args}), args);
    });

    it('an answer is read from params only: a call of an action that asks, whose arguments carry a state or responses, is refused', async () => {
      for (const smuggled of [{requestState: 'v1.a.b'}, {inputResponses: {answer: {action: 'accept', content: {replace: true}}}}]) {
        await rejectedWith('ARGUMENTS_INVALID', ask.begin(deps({binding: binding({arguments: Object.assign({id: 'first'}, smuggled)})})));
        // an action that declares no question may have an input of that name (/code-review of M13, 6)
        const state = await ask.begin(deps({asks: false, binding: binding({arguments: Object.assign({id: 'first'}, smuggled)})}));
        assert.strictEqual(state.askable, true);
      }
    });

    // /code-review of M13, 4: the key and the store are for a state; a call that carries none, and one that
    // cannot be asked, touch neither
    it('the key and the used-nonce store are reached only for a state: a first pass and a call no one can be asked touch neither', async () => {
      let reached = 0;
      const lazy = {key: () => { reached += 1; return key; }, used: () => { reached += 1; return used; }};
      await ask.begin(deps(lazy));
      await ask.begin(deps(Object.assign({modern: false}, lazy)));
      await ask.begin(deps(Object.assign({capabilities: null}, lazy)));
      assert.strictEqual(reached, 0);
      // a state needs both, and the form the key
      const state = await ask.begin(deps(lazy));
      asks(state);
      const made = await ask.formOf(state, deps(lazy));
      assert.strictEqual(reached, 1);
      assert.deepStrictEqual(asks(await retryWith(made, {action: 'accept', content: {replace: true}}, lazy)), {answer: {replace: true}});
      assert.strictEqual(reached, 3);
    });

    it('a key or a store that cannot be had is "could not be checked" for a retry, and "no one to ask" for a form: never a failed call of its own', async () => {
      const made = await firstForm();
      const broken = () => { throw new Error('identity: not initialized'); };
      const e1 = await retryWith(made, {action: 'accept', content: {replace: true}}, {key: broken}).then(() => null, (err) => err);
      assert.strictEqual(e1 && e1.code, 'ASK_STATE_UNCHECKED');
      const e2 = await retryWith(made, {action: 'accept', content: {replace: true}}, {used: broken}).then(() => null, (err) => err);
      assert.strictEqual(e2 && e2.code, 'ASK_STATE_UNCHECKED');
      // nothing was used up
      assert.deepStrictEqual(asks(await retryWith(made, {action: 'accept', content: {replace: true}})), {answer: {replace: true}});
      const state = await ask.begin(deps({key: broken}));
      assert.strictEqual(state.askable, true, 'a first pass needs no key');
      asks(state);
      await rejectedWith('ASK_UNAVAILABLE', ask.formOf(state, deps({key: broken})));
    });
  });

  describe('an answer that is none', () => {
    const NONE = [undefined, null, 'yes', {}, {action: 'accept'}, {action: 'accept', content: null}, {action: 'accept', content: 'yes'}, {action: 'accept', content: []},
      {action: 'accept', content: {replace: 'yes'}}, {action: 'accept', content: {replace: true, extra: 1}}, {action: 'approve', content: {replace: true}},
      {action: 'accept', content: {replace: true, note: 'n'.repeat(9000)}}];

    it('the same question is asked again, a round on; the state it came with is used up all the same', async () => {
      for (const response of NONE) {
        const made = await firstForm();
        const state = await retryWith(made, response);
        assert.deepStrictEqual(asks(state), {code: 'ASK_PENDING'}, String(JSON.stringify(response)).slice(0, 60));
        const again = await ask.formOf(state, deps());
        const carried = requestState.verify(key, again.requestState, binding());
        assert.deepStrictEqual([carried.round, carried.callRound, again.round], [2, 2, 2], 'its question\'s second round, and the call\'s');
        await rejectedWith('ASK_STATE_INVALID', retryWith(made, {action: 'accept', content: {replace: true}}));
      }
    });

    it('after three rounds with none, ctx.ask is ASK_UNAVAILABLE for that question', async () => {
      let made = await firstForm();
      for (let round = 1; round <= 2; round++) {
        const state = await retryWith(made, {action: 'accept', content: {replace: 'no'}});
        assert.deepStrictEqual(asks(state), {code: 'ASK_PENDING'});
        made = await ask.formOf(state, deps());
      }
      const third = await retryWith(made, {action: 'accept', content: {replace: 'no'}});
      assert.deepStrictEqual(asks(third), {code: 'ASK_UNAVAILABLE'});
      assert.strictEqual(third.pending, null);
      // another question of the same call is still asked
      assert.deepStrictEqual(asks(third, 'second'), {code: 'ASK_PENDING'});
    });

    // /code-review of M13, 7: what three rounds settled stays settled for the call
    it('a question whose three rounds brought none stays unavailable for the call: a later question\'s retry does not bring it back', async () => {
      let made = await firstForm();
      for (let round = 1; round <= 2; round++) made = await ask.formOf(asksThen(await retryWith(made, {action: 'accept', content: {replace: 'no'}})), deps());
      const third = await retryWith(made, {action: 'accept', content: {replace: 'no'}});
      assert.deepStrictEqual(asks(third), {code: 'ASK_UNAVAILABLE'});
      // the handler falls back and asks about another note
      assert.deepStrictEqual(asks(third, 'second'), {code: 'ASK_PENDING'});
      const next = await retryWith(await ask.formOf(third, deps()), {action: 'accept', content: {replace: true}});
      assert.deepStrictEqual(asks(next), {code: 'ASK_UNAVAILABLE'}, 'the first is not asked again');
      assert.deepStrictEqual(asks(next, 'second'), {answer: {replace: true}});
      assert.strictEqual(next.pending, null);
    });

    // The reviewer's I1 on #311: a call's rounds are every question's together. A handler whose question
    // reads differently on every pass (a time in its values) asked a "new" first round each time, for
    // ever, and a pass that asks is not billed.
    it('a handler whose question reads differently on every pass is asked eight rounds in all, then has no one to ask', async () => {
      let state = await ask.begin(deps());
      for (let i = 1; i <= 8; i++) {
        assert.deepStrictEqual(asks(state, `at-${i}`), {code: 'ASK_PENDING'}, String(i));
        const made = await ask.formOf(state, deps());
        const carried = requestState.verify(key, made.requestState, binding());
        // (made.round is the usage record's: how late in the call the module asked)
        assert.deepStrictEqual([carried.round, carried.callRound, made.round], [1, i, i], `a first round of its own question, and the call's round ${i}`);
        state = await retryWith(made, {action: 'accept', content: {replace: 'no'}});
      }
      assert.deepStrictEqual(asks(state, 'at-9'), {code: 'ASK_UNAVAILABLE'});
      assert.strictEqual(state.pending, null);
      // and no form is made past the eighth, whatever is pending
      const forced = Object.assign(ask.newState({askable: true}), {callRounds: 8, pending: {key: keyOf('x'), question: 'overwrite', text: textOf('x'), schema: DECLARED.schema}});
      await rejectedWith('ASK_UNAVAILABLE', ask.formOf(forced, deps()));
    });

    it('the eight are any mix of questions, three at most of one; what was answered on the way stays answered', async () => {
      // rounds 1 to 3: the first note, never answered
      let made = await firstForm();
      for (let round = 1; round <= 2; round++) made = await ask.formOf(asksThen(await retryWith(made, {action: 'accept', content: {replace: 'no'}})), deps());
      let state = await retryWith(made, {action: 'accept', content: {replace: 'no'}});
      assert.deepStrictEqual(asks(state), {code: 'ASK_UNAVAILABLE'});
      // round 4: answered; rounds 5 to 8: declined
      for (let i = 4; i <= 8; i++) {
        assert.deepStrictEqual(asks(state, `note-${i}`), {code: 'ASK_PENDING'}, String(i));
        made = await ask.formOf(state, deps());
        assert.strictEqual(requestState.verify(key, made.requestState, binding()).callRound, i);
        state = await retryWith(made, i === 4 ? {action: 'accept', content: {replace: true}} : {action: 'decline'});
      }
      assert.deepStrictEqual(asks(state, 'note-9'), {code: 'ASK_UNAVAILABLE'}, 'a ninth round has no one to ask');
      assert.deepStrictEqual([asks(state, 'note-4'), asks(state, 'note-8'), asks(state)], [{answer: {replace: true}}, {answer: null}, {code: 'ASK_UNAVAILABLE'}]);
    });

    it('a call settles at most eight questions: a ninth has no one to ask', async () => {
      let state = await ask.begin(deps());
      for (let i = 1; i <= 8; i++) {
        assert.deepStrictEqual(asks(state, `note-${i}`), {code: 'ASK_PENDING'}, String(i));
        state = await retryWith(await ask.formOf(state, deps()), {action: 'decline'});
        for (let j = 1; j <= i; j++) assert.deepStrictEqual(asks(state, `note-${j}`), {answer: null});
      }
      assert.deepStrictEqual(asks(state, 'note-9'), {code: 'ASK_UNAVAILABLE'});
      assert.strictEqual(state.pending, null);
    });

    it('an answer to a question the action no longer declares is none', async () => {
      const made = await firstForm();
      const state = await retryWith(made, {action: 'accept', content: {replace: true}}, {declared: () => null});
      assert.strictEqual(state.answers.size, 0);
    });
  });

  describe('more than one question', () => {
    it('the earlier answers ride in the state: a second question\'s retry brings both', async () => {
      const first = await retryWith(await firstForm(), {action: 'accept', content: {replace: true}});
      assert.deepStrictEqual(asks(first), {answer: {replace: true}});
      assert.deepStrictEqual(asks(first, 'second'), {code: 'ASK_PENDING'});
      const made = await ask.formOf(first, deps());
      const verified = requestState.verify(key, made.requestState, binding());
      assert.deepStrictEqual([verified.question, verified.round, verified.answers], [`${keyOf('second')}:overwrite`, 1, {[keyOf('first')]: {replace: true}}]);
      const second = await retryWith(made, {action: 'decline'});
      assert.deepStrictEqual(asks(second), {answer: {replace: true}});
      assert.deepStrictEqual(asks(second, 'second'), {answer: null});
    });

    it('what a state carries as earlier answers is taken entry by entry: only a question\'s key, only an object or null', async () => {
      // a state of this runtime's own making, holding what begin never puts there
      const odd = {[keyOf('first')]: {replace: true}, short: {x: 1}, [keyOf('second')]: 'text', ['x'.repeat(43)]: [1], constructor: {x: 1}};
      const state = requestState.mint(key, {question: `${keyOf('third')}:overwrite`, round: 1, callRound: 1, answers: odd}, binding());
      const got = await ask.begin(deps({params: {requestState: state, inputResponses: {answer: {action: 'decline'}}}}));
      assert.deepStrictEqual([...got.answers.keys()].sort(), [keyOf('first'), keyOf('third')].sort());
      assert.strictEqual(Object.getPrototypeOf(got.answers), Map.prototype);
    });

    it('a state whose question is not a key and a name is refused as any other', async () => {
      for (const q of ['overwrite', `${keyOf('first')}`, `${keyOf('first')}:`, `short:overwrite`, `${keyOf('first')}:bad name`]) {
        const state = requestState.mint(key, {question: q, round: 1, callRound: 1, answers: {}}, binding());
        await rejectedWith('ASK_STATE_INVALID', ask.begin(deps({params: {requestState: state, inputResponses: {answer: {action: 'decline'}}}})));
      }
    });
  });
});
