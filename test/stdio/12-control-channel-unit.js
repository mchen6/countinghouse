// lib/control-channel.js (packs in place, part 2, plan Task A2), server-free:
// requests are answered by id, one at a time and in order; an unknown type,
// a request not served yet and a handler's failure each answer ok: false.
const assert = require('assert');
const {start} = require('../../lib/control-channel');

describe('stdio 12: the control channel, server-free', () => {
  function channel(handlers) {
    let listener = null;
    // the replies, and apart from them the unasked ready, sent once it listens
    const sent = [];
    const all = [];
    const ch = start(handlers, {on: (fn) => { listener = fn; }, off: () => { listener = null; }, send: (m) => { all.push(m); if (m.type !== 'ready') sent.push(m); }});
    const ask = (msg) => listener(msg);
    const settled = () => new Promise((r) => setTimeout(r, 50));
    return {ch, ask, sent, settled, all};
  }

  it('the shared runtime\'s requests: restore and drain are served when given; tell sends an unasked message (C3)', async () => {
    const {ask, sent, settled, all} = channel({restore: async (m) => ({sessions: m.sessions.length}), drain: async () => ({})});
    ask({id: 'd1', type: 'restore', sessions: [], declines: []});
    ask({id: 'd2', type: 'drain'});
    await settled();
    assert.deepStrictEqual(sent.map((m) => [m.id, m.ok]), [['d1', true], ['d2', true]]);
    assert.strictEqual(sent[0].sessions, 0);
    require('../../lib/control-channel').tell({type: 'session-gone', session: 'abc'});
    assert.deepStrictEqual(all[all.length - 1], {type: 'session-gone', session: 'abc'}, 'no id: a message, not a request');
  });

  it('tell refuses a message with an id or no type, and sends nothing without a channel', () => {
    const cc = require('../../lib/control-channel');
    const {all} = channel({});
    const before = all.length;
    assert.throws(() => cc.tell({type: 'x', id: 1}), /id/);
    assert.throws(() => cc.tell({}), /type/);
    assert.strictEqual(all.length, before);
    cc.resetForTests();
    assert.strictEqual(cc.tell({type: 'session-gone', session: 'x'}), false, 'no channel: nothing sent');
  });

  it('says ready, unasked and once, as soon as it listens', () => {
    const {all} = channel({});
    assert.deepStrictEqual(all, [{type: 'ready'}]);
  });

  it('answers each request by its id; unknown, not served and failing requests answer ok: false with their codes', async () => {
    const {ask, sent, settled} = channel({load: async (m) => ({tools: [m.name]}), unload: async () => { throw Object.assign(new Error('no such pack'), {code: 'PACK_UNKNOWN'}); }});
    ask({id: 1, type: 'load', name: 'one'});
    ask({id: 2, type: 'nonsense'});
    ask({id: 3, type: 'reload', name: 'one'});
    ask({id: 4, type: 'unload', name: 'two'});
    ask({type: 'load'});   // no id: nothing to answer
    await settled();
    assert.deepStrictEqual(sent.map((m) => [m.id, m.ok, m.code || null]), [[1, true, null], [2, false, 'CONTROL_UNKNOWN'], [3, false, 'CONTROL_NOT_READY'], [4, false, 'PACK_UNKNOWN']]);
    assert.deepStrictEqual(sent[0].tools, ['one']);
    assert.strictEqual(sent[3].message, 'no such pack');
  });

  it('applies requests one at a time, in order, even when an earlier one takes longer', async () => {
    const order = [];
    const {ask, sent} = channel({load: async (m) => {
      order.push(`start ${m.name}`);
      await new Promise((r) => setTimeout(r, m.name === 'slow' ? 80 : 1));
      order.push(`end ${m.name}`);
      return {};
    }});
    ask({id: 1, type: 'load', name: 'slow'});
    ask({id: 2, type: 'load', name: 'quick'});
    await new Promise((r) => setTimeout(r, 200));
    assert.deepStrictEqual(order, ['start slow', 'end slow', 'start quick', 'end quick']);
    assert.deepStrictEqual(sent.map((m) => m.id), [1, 2]);
  });

  it('a reply cannot carry another id or ok than its own', async () => {
    const {ask, sent, settled} = channel({set: async () => ({id: 99, ok: false, value: 1})});
    ask({id: 7, type: 'set', name: 'requestTimeout', value: 20});
    await settled();
    assert.deepStrictEqual(sent, [{value: 1, id: 7, ok: true}]);
  });
});

describe('stdio 12b: the runtime asks ch-local (part 3 P2, Task 4)', () => {
  const control = require('../../lib/control-channel');
  function pair() {
    let listener = null;
    const sent = [];
    const ch = control.start({}, {on: (fn) => { listener = fn; }, off: () => { listener = null; }, send: (m) => sent.push(m)});
    return {ch, sent, deliver: (m) => listener(m)};
  }
  afterEach(() => control.resetForTests());

  it('ask sends a request with an r-id; the reply goes to it, never answered as an unknown request', async () => {
    const {sent, deliver} = pair();
    const p = control.ask({type: 'may-elicit', client: {name: 'claude-code', version: '2.1.323'}});
    const req = sent.find((m) => m.type === 'may-elicit');
    assert.match(String(req.id), /^r\d+$/);
    deliver({id: req.id, ok: true, mayElicit: false, why: 'client hook present'});
    assert.deepStrictEqual(await p, {id: req.id, ok: true, mayElicit: false, why: 'client hook present'});
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!sent.some((m) => m.code === 'CONTROL_UNKNOWN'), JSON.stringify(sent));
  });

  it('no answer (an older ch-local ignores the request): CONTROL_NO_ANSWER after its timeout; no channel: CONTROL_NONE', async () => {
    pair();
    const t = Date.now();
    assert.deepStrictEqual(await control.ask({type: 'may-elicit'}, {timeoutMs: 60}), {ok: false, code: 'CONTROL_NO_ANSWER'});
    assert.ok(Date.now() - t >= 50);
    control.resetForTests();
    assert.deepStrictEqual(await control.ask({type: 'may-elicit'}), {ok: false, code: 'CONTROL_NONE'});
  });

  it('an older ch-local that answers the request as unknown: that, not a hang', async () => {
    const {sent, deliver} = pair();
    const p = control.ask({type: 'may-elicit'});
    const req = sent.find((m) => m.type === 'may-elicit');
    deliver({id: req.id, ok: false, code: 'CONTROL_UNKNOWN'});
    assert.strictEqual((await p).code, 'CONTROL_UNKNOWN');
  });
});
