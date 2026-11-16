'use strict';
// MCP completeness M14 (the design, section 8, "Over composition"): a part's
// ctx.ask reaches the outer call's user. Server-free: real call tokens, the
// real request-state mechanics.
//
// - A hop's token carries its own action; the call's ask state is held on
//   the OUTER call's token only, and a part's ask finds it by its chain. So
//   there is one state a call: one question a round, three rounds of one
//   question and eight of the call, whoever in the chain asks.
// - Who asks is the token entry's device and action and the asking worker's
//   own module and spec, never the message: a part asks only what its own
//   action declares.
// - The dialog is prefixed with the OUTER, listed module's name: an unlisted
//   part is never named to the client (the reviewer's ruling, 2026-11-16).
// - The pending question and the state name who asked, so the retry's answer
//   is checked against the asker's own form.
const assert = require('assert');
const crypto = require('crypto');
const callTokens = require('../../lib/call-tokens');
const questions = require('../../lib/module-questions');
const requestState = require('../../lib/request-state');
const ask = require('../../lib/module-ask');
const {CountinghouseError} = require('../../lib/countinghouse-error');

const OUTER = {module: 'pack', deviceID: 'dev-outer', serviceID: 'urn:countinghouse-test:serviceID:packService', actionName: 'run'};
const PART = {module: 'part', deviceID: 'dev-part', serviceID: 'urn:countinghouse-test:serviceID:partService', actionName: 'store'};
const OTHER = {module: 'other', deviceID: 'dev-other', serviceID: 'urn:countinghouse-test:serviceID:otherService', actionName: 'send'};
const specOf = (who, declared) => ({device: {serviceList: {[who.serviceID]: {actionList: [{name: who.actionName, questions: declared}]}}}});
const SPECS = {
  pack: specOf(OUTER, {confirm: {message: 'Run {what}?', schema: '/packService/run/questions/confirm'}}),
  part: specOf(PART, {overwrite: {message: 'Replace {id}?', schema: '/partService/store/questions/overwrite'}}),
  other: specOf(OTHER, {overwrite: {message: 'Replace {id}?', schema: '/otherService/send/questions/overwrite'}})
};
const askerOf = (who) => ({deviceID: who.deviceID, serviceID: who.serviceID, actionName: who.actionName});
// a question's key: of who asks it and of the text the user reads (the outer module's name before it)
const keyOf = (who, question, text) => questions.keyOf({module: who.module, serviceID: who.serviceID, action: who.actionName, question, text});

describe('questions 07: a part\'s ctx.ask, through composition (MCP completeness M14)', () => {
  const issued = [];
  const refusedWith = (code, fn) => assert.throws(fn, (e) => e instanceof CountinghouseError && e.code === code, code);
  afterEach(() => { for (const t of issued.splice(0)) callTokens.drop(t); });
  // the outer call, sent to worker w-pack with this ask state, and a hop under `parent` to `who` in its own worker
  const outer = (state) => {
    const t = callTokens.issue({billingKey: 'k', module: OUTER.module, workerId: 'w-pack', deviceID: OUTER.deviceID, serviceID: OUTER.serviceID, actionName: OUTER.actionName, ask: state});
    issued.push(t);
    return t;
  };
  const hop = (parent, who) => {
    const t = callTokens.issue({billingKey: 'k', module: who.module, workerId: `w-${who.module}`, deviceID: who.deviceID, serviceID: who.serviceID, actionName: who.actionName, parent});
    issued.push(t);
    return t;
  };
  // a worker's ask as its listener hands it on: its own module's spec and name
  const asks = (token, who, name, values) => ask.answer({token, name, values}, `w-${who.module}`, SPECS[who.module], who.module);
  // a call the gateway began for the pack: someone to ask, and the name its dialogs carry
  const begun = (over = {}) => Object.assign(ask.newState({askable: true, shownAs: OUTER.module}), over);

  describe('the token chain', () => {
    it('a hop\'s token carries its own action; the ask state is on the outer call\'s token only, found from any token of its chain', () => {
      const state = begun();
      const top = outer(state);
      const first = hop(top, PART);
      const second = hop(first, OTHER);
      const entry = callTokens.resolve(first, {workerId: 'w-part'});
      assert.deepStrictEqual([entry.serviceID, entry.actionName, entry.ask], [PART.serviceID, PART.actionName, null], 'its own action, and no state of its own');
      assert.strictEqual(callTokens.outerOf(entry).ask, state);
      assert.strictEqual(callTokens.outerOf(callTokens.resolve(second, {workerId: 'w-other'})).ask, state, 'two hops down');
      assert.strictEqual(callTokens.outerOf(callTokens.resolve(top, {workerId: 'w-pack'})).ask, state, 'the outer call is its own');
      assert.strictEqual(callTokens.outerOf(null), null);
    });
  });

  describe('a part asks', () => {
    it('its own declared question: recorded on the outer call with who asked, under the outer module\'s name', () => {
      const state = begun();
      const token = hop(outer(state), PART);
      refusedWith('ASK_PENDING', () => asks(token, PART, 'overwrite', {id: 'a.txt'}));
      const text = 'pack: Replace a.txt?';
      assert.deepStrictEqual(state.pending, {key: keyOf(PART, 'overwrite', text), question: 'overwrite', text, schema: '/partService/store/questions/overwrite', asker: askerOf(PART)});
      assert.ok(!state.pending.text.includes('part'), 'an unlisted part is never named to the client');
    });

    it('the outer handler\'s own question names itself as who asked', () => {
      const state = begun();
      refusedWith('ASK_PENDING', () => asks(outer(state), OUTER, 'confirm', {what: 'it'}));
      assert.deepStrictEqual(state.pending, {key: keyOf(OUTER, 'confirm', 'pack: Run it?'), question: 'confirm', text: 'pack: Run it?', schema: '/packService/run/questions/confirm', asker: askerOf(OUTER)});
    });

    it('only what its own action declares: not the outer call\'s question, and the outer not a part\'s', () => {
      const state = begun();
      const top = outer(state);
      refusedWith('ASK_NOT_DECLARED', () => asks(hop(top, PART), PART, 'confirm', {what: 'it'}));
      refusedWith('ASK_NOT_DECLARED', () => asks(top, OUTER, 'overwrite', {id: 'a.txt'}));
      assert.strictEqual(state.pending, null);
    });

    it('an answer is for who asked: another part\'s question of the same name and text is another question', () => {
      const text = 'pack: Replace a.txt?';
      const state = begun({answers: new Map([[keyOf(PART, 'overwrite', text), {replace: true}]])});
      const top = outer(state);
      assert.deepStrictEqual(asks(hop(top, PART), PART, 'overwrite', {id: 'a.txt'}), {replace: true});
      refusedWith('ASK_PENDING', () => asks(hop(top, OTHER), OTHER, 'overwrite', {id: 'a.txt'}));
      assert.deepStrictEqual([state.pending.key, state.pending.asker], [keyOf(OTHER, 'overwrite', text), askerOf(OTHER)]);
    });

    it('one question a round, whoever in the chain asks: the first with no answer is the one asked', () => {
      const state = begun();
      const top = outer(state);
      refusedWith('ASK_PENDING', () => asks(hop(top, PART), PART, 'overwrite', {id: 'a.txt'}));
      refusedWith('ASK_PENDING', () => asks(hop(top, OTHER), OTHER, 'overwrite', {id: 'b.txt'}));
      refusedWith('ASK_PENDING', () => asks(top, OUTER, 'confirm', {what: 'it'}));
      assert.deepStrictEqual(state.pending.asker, askerOf(PART));
    });

    it('the call\'s rounds are the chain\'s: after eight a part has no one to ask, and a question three rounds left unanswered stays so for a part', () => {
      const spent = begun({callRounds: 8});
      refusedWith('ASK_UNAVAILABLE', () => asks(hop(outer(spent), PART), PART, 'overwrite', {id: 'a.txt'}));
      assert.strictEqual(spent.pending, null);
      const given = begun({unavailable: new Set([keyOf(PART, 'overwrite', 'pack: Replace a.txt?')])});
      refusedWith('ASK_UNAVAILABLE', () => asks(hop(outer(given), PART), PART, 'overwrite', {id: 'a.txt'}));
    });

    // the reviewer's addition: no one to ask is no one to ask for a part too
    it('under an outer call that has no one to ask (a legacy request, HTTP invoke-action, a task), a part has no one either', () => {
      for (const state of [ask.newState({askable: false}), null, undefined]) {
        refusedWith('ASK_UNAVAILABLE', () => asks(hop(outer(state), PART), PART, 'overwrite', {id: 'a.txt'}));
        refusedWith('ASK_UNAVAILABLE', () => asks(hop(hop(outer(state), OTHER), PART), PART, 'overwrite', {id: 'a.txt'}));
      }
    });

    it('by its own worker\'s token only: a hop\'s token in another worker\'s hands is no call of its', () => {
      const state = begun();
      const token = hop(outer(state), PART);
      refusedWith('CALL_TOKEN_INVALID', () => ask.answer({token, name: 'overwrite', values: {id: 'a.txt'}}, 'w-other', SPECS.other, 'other'));
      assert.strictEqual(state.pending, null);
    });

    it('with no name for its dialogs (a state the gateway did not begin for a listed module) the asker\'s own name is used', () => {
      const state = ask.newState({askable: true});
      refusedWith('ASK_PENDING', () => asks(outer(state), OUTER, 'confirm', {what: 'it'}));
      assert.strictEqual(state.pending.text, 'pack: Run it?');
    });
  });

  // The reviewer's ruling (2026-11-16): whether a call can end on a question is the called action's own
  // declaration, or that of an action it can reach through the modules' verified declared calls. A
  // module's calls are its own, whichever of its actions makes them.
  describe('whether a call can end on a question', () => {
    const at = (who, actionName = who.actionName) => ({deviceID: who.deviceID, serviceID: who.serviceID, actionName});
    const same = (a, b) => a.deviceID === b.deviceID && a.serviceID === b.serviceID && a.actionName === b.actionName;
    // who declares a question, and what each module calls
    const world = (askers, calls) => ({
      asksAt: (target) => askers.some((a) => same(a, target)),
      callsOf: (deviceID) => calls[deviceID] || []
    });

    it('the called action declares one: yes, and nothing it calls is looked at', () => {
      let looked = 0;
      assert.strictEqual(ask.canAsk(at(OUTER), {asksAt: () => true, callsOf: () => { looked += 1; return []; }}), true);
      assert.strictEqual(looked, 0);
    });

    it('it declares none and calls nothing, or nothing it can reach declares one: no', () => {
      assert.strictEqual(ask.canAsk(at(OUTER), world([], {})), false);
      assert.strictEqual(ask.canAsk(at(OUTER), world([], {[OUTER.deviceID]: [at(PART)], [PART.deviceID]: [at(OTHER)]})), false);
    });

    it('an action it calls declares one, or one that action\'s module calls does: yes', () => {
      assert.strictEqual(ask.canAsk(at(OUTER), world([at(PART)], {[OUTER.deviceID]: [at(PART)]})), true);
      assert.strictEqual(ask.canAsk(at(OUTER), world([at(OTHER)], {[OUTER.deviceID]: [at(PART)], [PART.deviceID]: [at(OTHER)]})), true, 'two hops down');
    });

    it('only an action that is called counts: another action of a part, with a question, is not reached', () => {
      assert.strictEqual(ask.canAsk(at(OUTER), world([at(PART, 'another')], {[OUTER.deviceID]: [at(PART)]})), false);
      // nor the called module's own other action: the call is of one action
      assert.strictEqual(ask.canAsk(at(OUTER), world([at(OUTER, 'another')], {})), false);
    });

    it('modules that call each other are walked once each', () => {
      const seen = [];
      const calls = {[OUTER.deviceID]: [at(PART)], [PART.deviceID]: [at(OTHER), at(OUTER)], [OTHER.deviceID]: [at(PART)]};
      const w = world([], calls);
      assert.strictEqual(ask.canAsk(at(OUTER), {asksAt: w.asksAt, callsOf: (d) => { seen.push(d); return w.callsOf(d); }}), false);
      assert.deepStrictEqual(seen.sort(), [OTHER.deviceID, OUTER.deviceID, PART.deviceID].sort());
    });

    it('the walk is bounded: past its bound, or when a lookup fails, the call is taken as one that can', () => {
      // a chain of modules longer than the bound, none of which asks
      const chain = {};
      for (let i = 0; i <= ask.MAX_REACH + 1; i++) chain[`d${i}`] = [{deviceID: `d${i + 1}`, serviceID: 's', actionName: 'a'}];
      assert.strictEqual(ask.canAsk({deviceID: 'd0', serviceID: 's', actionName: 'a'}, world([], chain)), true);
      const within = {};
      for (let i = 0; i < 5; i++) within[`d${i}`] = [{deviceID: `d${i + 1}`, serviceID: 's', actionName: 'a'}];
      assert.strictEqual(ask.canAsk({deviceID: 'd0', serviceID: 's', actionName: 'a'}, world([], within)), false);
      assert.strictEqual(ask.canAsk(at(OUTER), {asksAt: () => { throw new Error('gone'); }, callsOf: () => []}), true);
      assert.strictEqual(ask.canAsk(at(OUTER), {asksAt: () => false, callsOf: () => { throw new Error('gone'); }}), true);
      assert.strictEqual(ask.canAsk(at(OUTER), {asksAt: () => false, callsOf: () => 'not a list'}), false, 'no calls it can read are no calls');
    });

    it('begin and the arguments\' copy take it as a value or as a function, asked only where someone can be asked', async () => {
      let asked = 0;
      const lazy = () => { asked += 1; return true; };
      const base = {modern: true, capabilities: {elicitation: {}}, questionsOn: true, binding: {caller: 'c', session: '', method: 'tools/call', tool: 't', arguments: {requestState: 'x'}}};
      assert.strictEqual((await ask.begin(Object.assign({}, base, {modern: false, asks: lazy}))).askable, false);
      assert.strictEqual(asked, 0, 'a call no one can be asked does not walk');
      await assert.rejects(ask.begin(Object.assign({}, base, {asks: lazy})), (e) => e.code === 'ARGUMENTS_INVALID');
      assert.strictEqual(asked, 1);
      const args = {id: 'a'};
      assert.ok(ask.bindingArguments({state: begun(), asks: () => true, arguments: args}) !== args);
      assert.strictEqual(ask.bindingArguments({state: begun(), asks: () => false, arguments: args}), args);
    });
  });

  describe('the state names who asked', () => {
    const key = crypto.randomBytes(32);
    const FORM = {type: 'object', properties: {replace: {type: 'boolean'}}, required: ['replace']};
    const binding = {caller: 'c_caller', session: '', method: 'tools/call', tool: 'run', arguments: {what: 'it'}};
    let used = null;
    let asked = null;
    beforeEach(() => { used = new requestState.UsedNonces(); asked = []; });
    // the main thread's lookup of who asked, as the gateway gives it: that device's declaration and validators, as they stand now
    const ofAsker = (asker) => {
      asked.push(asker);
      const who = [OUTER, PART, OTHER].find((w) => w.deviceID === asker.deviceID);
      if (who == null) return null;
      return {
        declared: (name) => questions.declared(SPECS[who.module], asker.serviceID, asker.actionName, name),
        form: async (pointer, content) => ({schema: FORM, valid: content === undefined ? null : (content != null && typeof(content.replace) === 'boolean' && Object.keys(content).length === 1), pointer})
      };
    };
    const deps = (over = {}) => Object.assign({modern: true, capabilities: {elicitation: {}}, questionsOn: true, asks: true, shownAs: OUTER.module, binding, ofAsker, key, used}, over);
    // a pass in which the part asks, and the form made for it
    const partAsks = async (state) => {
      const token = hop(outer(state), PART);
      refusedWith('ASK_PENDING', () => asks(token, PART, 'overwrite', {id: 'a.txt'}));
      return ask.formOf(state, deps());
    };
    const retry = (made, response, over = {}) => ask.begin(deps(Object.assign({params: {requestState: made.requestState, inputResponses: {answer: response}}}, over)));

    it('begin gives the state the name its dialogs carry: the called, listed module\'s', async () => {
      assert.strictEqual((await ask.begin(deps())).shownAs, 'pack');
    });

    it('the form is the asker\'s own, and the state says who asked: a key, a name, a device, a service, an action', async () => {
      const state = await ask.begin(deps());
      const made = await partAsks(state);
      assert.deepStrictEqual(asked, [askerOf(PART)], 'the form came from the asker\'s validators');
      assert.deepStrictEqual(made.inputRequests.answer.params, {mode: 'form', message: 'pack: Replace a.txt?', requestedSchema: FORM});
      const carried = requestState.verify(key, made.requestState, binding);
      assert.deepStrictEqual(JSON.parse(carried.question), [keyOf(PART, 'overwrite', 'pack: Replace a.txt?'), 'overwrite', PART.deviceID, PART.serviceID, PART.actionName]);
    });

    it('the retry\'s answer is checked against the asker\'s form, looked up afresh, and the part\'s next ask gets it', async () => {
      const made = await partAsks(await ask.begin(deps()));
      asked.length = 0;
      const state = await retry(made, {action: 'accept', content: {replace: true}});
      assert.deepStrictEqual(asked, [askerOf(PART)]);
      assert.deepStrictEqual(asks(hop(outer(state), PART), PART, 'overwrite', {id: 'a.txt'}), {replace: true});
      // and an answer that does not fit the asker's form is none: asked again, a round on
      const again = await partAsks(await ask.begin(deps()));
      const none = await retry(again, {action: 'accept', content: {replace: 'yes'}});
      assert.strictEqual(none.answers.size, 0);
      assert.deepStrictEqual([...none.rounds.values()], [1]);
    });

    it('an asker that is gone, or no longer declares the question, makes the answer none', async () => {
      const made = await partAsks(await ask.begin(deps()));
      const gone = await retry(made, {action: 'accept', content: {replace: true}}, {ofAsker: () => null});
      assert.strictEqual(gone.answers.size, 0);
      const made2 = await partAsks(await ask.begin(deps()));
      const undeclared = await retry(made2, {action: 'accept', content: {replace: true}}, {ofAsker: (a) => Object.assign(ofAsker(a), {declared: () => null})});
      assert.strictEqual(undeclared.answers.size, 0);
    });

    it('a state whose question is not exactly who asked is refused as any other', async () => {
      const k = keyOf(PART, 'overwrite', 'pack: Replace a.txt?');
      for (const q of [`${k}:overwrite`, JSON.stringify([k, 'overwrite']), JSON.stringify([k, 'overwrite', PART.deviceID, PART.serviceID]), JSON.stringify([k, 'overwrite', PART.deviceID, PART.serviceID, PART.actionName, 'more']),
        JSON.stringify([k, 'overwrite', 7, PART.serviceID, PART.actionName]), JSON.stringify([k, 'over write', PART.deviceID, PART.serviceID, PART.actionName]), JSON.stringify(['short', 'overwrite', PART.deviceID, PART.serviceID, PART.actionName]),
        JSON.stringify([k, 'overwrite', '', PART.serviceID, PART.actionName]), JSON.stringify({key: k}), 'not json']) {
        const state = requestState.mint(key, {question: q, round: 1, callRound: 1, answers: {}}, binding);
        await assert.rejects(ask.begin(deps({params: {requestState: state, inputResponses: {answer: {action: 'decline'}}}})), (e) => e.code === 'ASK_STATE_INVALID' && e.why === 'question', q.slice(0, 60));
      }
    });
  });
});
