// Never silent (packs in place, part 2, plan Task A4), server-free: a notice
// is sent once as notifications/message, and goes once on the next result of
// a tool of its pack (or of any tool, for a pack no longer loaded).
const assert = require('assert');
const notices = require('../../lib/notices');
const {finishToolCall} = require('../../lib/usage/receipt');

describe('stdio 13: pack change notices', () => {
  const sent = [];
  before(() => notices.setNotifier((m) => sent.push(m)));
  after(() => notices.setNotifier(null));
  beforeEach(() => { sent.length = 0; notices.take(null); notices.take('ch-pack-x'); notices.take('ch-pack-y'); });

  it('one notifications/message per notice, at level notice', () => {
    notices.add('ch-pack-x', 'ch-pack-x upgraded 0.1.0 → 0.2.0');
    assert.deepStrictEqual(sent, [{jsonrpc: '2.0', method: 'notifications/message', params: {level: 'notice', logger: 'countinghouse', data: 'ch-pack-x upgraded 0.1.0 → 0.2.0'}}]);
  });

  it('the next result of a tool of that pack carries it once; another pack\'s does not; a notice for no module goes on any tool\'s next result', () => {
    notices.add('ch-pack-x', 'x upgraded');
    notices.add(null, 'z removed');
    const y = finishToolCall({usage: null, call: null, result: {content: [{type: 'text', text: 'y'}]}, role: 'scenario', tool: 'y', module: 'ch-pack-y', startedMs: 0});
    assert.deepStrictEqual(y.content.map((c) => c.text), ['y', 'z removed']);
    const x1 = finishToolCall({usage: null, call: null, result: {content: [{type: 'text', text: 'x'}]}, role: 'scenario', tool: 'x', module: 'ch-pack-x', startedMs: 0});
    assert.deepStrictEqual(x1.content.map((c) => c.text), ['x', 'x upgraded']);
    const x2 = finishToolCall({usage: null, call: null, result: {content: [{type: 'text', text: 'x'}]}, role: 'scenario', tool: 'x', module: 'ch-pack-x', startedMs: 0});
    assert.deepStrictEqual(x2.content.map((c) => c.text), ['x'], 'once');
  });

  it('a notice is one line of at most 200 characters', () => {
    notices.add('ch-pack-x', `line one\nline two ${'z'.repeat(400)}`);
    const [t] = notices.take('ch-pack-x');
    assert.ok(!t.includes('\n'));
    assert.strictEqual(t.length, 200);
  });

  it('past PER_MODULE_MAX, the newest are kept and the others counted in one line: never silent', () => {
    for (let n = 1; n <= notices.PER_MODULE_MAX + 3; n++) notices.add('ch-pack-x', `change ${n}`);
    const out = notices.take('ch-pack-x');
    assert.strictEqual(out.length, notices.PER_MODULE_MAX + 1);
    assert.strictEqual(out[0], '3 earlier changes to ch-pack-x not listed here');
    assert.strictEqual(out[out.length - 1], `change ${notices.PER_MODULE_MAX + 3}`);
  });

  it('logging/setLevel: answered over stdio; a level above notice stops the notifications, never the result line; refused over HTTP', (done) => {
    const gateway = require('../../lib/mcp/gateway');
    gateway.handle({jsonrpc: '2.0', id: 1, method: 'logging/setLevel', params: {level: 'warning'}}, null, null, (e1, r1) => {
      assert.deepStrictEqual(r1.result, {});
      notices.add('ch-pack-x', 'quiet');
      assert.deepStrictEqual(sent, [], 'no notification');
      assert.deepStrictEqual(notices.take('ch-pack-x'), ['quiet']);
      gateway.handle({jsonrpc: '2.0', id: 2, method: 'logging/setLevel', params: {level: 'loud'}}, null, null, (e2, r2) => {
        assert.ok(r2.error != null, 'an unknown level');
        gateway.handle({jsonrpc: '2.0', id: 3, method: 'logging/setLevel', params: {level: 'debug'}}, null, null, (e3, r3) => {
          assert.ok(r3.error != null && /method not found/.test(r3.error.message), 'HTTP declares no logging');
          gateway.handle({jsonrpc: '2.0', id: 4, method: 'logging/setLevel', params: {level: 'debug'}}, null, null, () => {
            notices.add('ch-pack-x', 'heard');
            assert.strictEqual(sent.length, 1);
            notices.take('ch-pack-x');
            done();
          }, {listChanged: true});
        });
      }, {listChanged: true});
    }, {listChanged: true});
  });
});
