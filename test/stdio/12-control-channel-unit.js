// lib/control-channel.js (packs in place, part 2, plan Task A2), server-free:
// requests are answered by id, one at a time and in order; an unknown type,
// a request not served yet and a handler's failure each answer ok: false.
const assert = require('assert');
const {start} = require('../../lib/control-channel');

describe('stdio 12: the control channel, server-free', () => {
  function channel(handlers) {
    let listener = null;
    const sent = [];
    const ch = start(handlers, {on: (fn) => { listener = fn; }, off: () => { listener = null; }, send: (m) => sent.push(m)});
    const ask = (msg) => listener(msg);
    const settled = () => new Promise((r) => setTimeout(r, 50));
    return {ch, ask, sent, settled};
  }

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
    ask({id: 7, type: 'set', name: 'locale', value: 'zh'});
    await settled();
    assert.deepStrictEqual(sent, [{value: 1, id: 7, ok: true}]);
  });
});
