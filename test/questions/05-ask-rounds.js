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
  const deps = (over = {}) => Object.assign({modern: true, questionsOn: true, binding: binding(), declared: (name) => (name === 'overwrite' ? DECLARED : null), form, key, used}, FORMS, over);
  const rejectedWith = (code, promise) => assert.rejects(promise, (e) => e instanceof CountinghouseError && e.code === code, code);
  // one pass of a handler that asks about `id`: its ask's outcome
  const asks = (state, id = 'first') => { try { return {answer: ask.decide(CONTEXT(state), 'overwrite', {id})}; } catch (e) { return {code: e.code}; } };
  // a first pass that ends pending, and the form made for it
  const firstForm = async (over = {}) => {
    const state = await ask.begin(deps(over));
    assert.deepStrictEqual(asks(state), {code: 'ASK_PENDING'});
    return ask.formOf(state, deps(over));
  };
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
      }
      // nothing was used up: the same retry, with the store back, is taken
      assert.deepStrictEqual(asks(await retryWith(made, {action: 'accept', content: {replace: true}})), {answer: {replace: true}});
      // and a store that answers anything but a plain true is "used"
      const made2 = await firstForm();
      await rejectedWith('ASK_STATE_INVALID', retryWith(made2, {action: 'accept', content: {replace: true}}, {used: {use: async () => 'yes'}}));
    });

    it('an answer is read from params only: a call whose arguments carry a state or responses is refused', async () => {
      for (const smuggled of [{requestState: 'v1.a.b'}, {inputResponses: {answer: {action: 'accept', content: {replace: true}}}}]) {
        await rejectedWith('ARGUMENTS_INVALID', ask.begin(deps({binding: binding({arguments: Object.assign({id: 'first'}, smuggled)})})));
      }
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
        assert.strictEqual(requestState.verify(key, again.requestState, binding()).round, 2);
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
      const state = requestState.mint(key, {question: `${keyOf('third')}:overwrite`, round: 1, answers: odd}, binding());
      const got = await ask.begin(deps({params: {requestState: state, inputResponses: {answer: {action: 'decline'}}}}));
      assert.deepStrictEqual([...got.answers.keys()].sort(), [keyOf('first'), keyOf('third')].sort());
      assert.strictEqual(Object.getPrototypeOf(got.answers), Map.prototype);
    });

    it('a state whose question is not a key and a name is refused as any other', async () => {
      for (const q of ['overwrite', `${keyOf('first')}`, `${keyOf('first')}:`, `short:overwrite`, `${keyOf('first')}:bad name`]) {
        const state = requestState.mint(key, {question: q, round: 1, answers: {}}, binding());
        await rejectedWith('ASK_STATE_INVALID', ask.begin(deps({params: {requestState: state, inputResponses: {answer: {action: 'decline'}}}})));
      }
    });
  });
});
