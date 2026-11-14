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
});
