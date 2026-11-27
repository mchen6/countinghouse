'use strict';
// R-cold-prompts: a legacy (2025-11-25) stdio client's prompts and resources
// lists, kept as what it was shown and compared after a settled change
// (lib/mcp/plain-list-notices.js, the stdio path of lib/route-manager.js).
// Server-free: the lists are a fake whose answers the test releases, and the
// settle is mocked, so every interleaving the review named is driven in
// order: a change during the client's first list, an error answer, a
// comparison that meets a client list in flight, and the resources and their
// templates, each its own list.
const assert = require('assert');
const {mock} = require('node:test');
const {createPlainListNotices} = require('../../lib/mcp/plain-list-notices');

const SETTLE = 20;
const PROMPTS = 'notifications/prompts/list_changed';
const RESOURCES = 'notifications/resources/list_changed';

function world() {
  const lists = {'prompts/list': 'P0', 'resources/list': 'R0', 'resources/templates/list': 'T0'};
  const pending = [];
  const sent = [];
  const notices = createPlainListNotices({
    list: (method, cb) => pending.push({method, cb}),
    notify: (method) => sent.push(method),
    settleMs: SETTLE
  });
  const w = {lists, pending, sent, notices};
  // every list asked for so far answered, as the lists are now
  w.release = () => { for (const p of pending.splice(0)) p.cb(lists[p.method]); };
  w.fail = () => { for (const p of pending.splice(0)) p.cb(null); };
  w.settle = () => mock.timers.tick(SETTLE);
  // a client's first page asked for and answered, its whole list taken
  w.listed = (method) => { const t = notices.began(method); notices.answered(t, true); w.release(); };
  return w;
}

describe('stdio 52: a legacy stdio client\'s prompts and resources lists (R-cold-prompts)', () => {
  beforeEach(() => mock.timers.enable({apis: ['setTimeout']}));
  afterEach(() => mock.timers.reset());

  it('a list asked for and changed is announced once settled; one not asked for, nothing', () => {
    const w = world();
    w.listed('prompts/list');
    w.lists['prompts/list'] = 'P1';
    w.lists['resources/list'] = 'R1';
    w.notices.changed();
    assert.deepStrictEqual(w.sent, [], 'still settling');
    w.settle();
    w.release();
    assert.deepStrictEqual(w.sent, [PROMPTS]);
  });

  it('a change that leaves the list the same, or no list asked for, says nothing', () => {
    const w = world();
    w.notices.changed();
    w.settle();
    w.release();
    w.listed('prompts/list');
    w.notices.changed();
    w.settle();
    w.release();
    assert.deepStrictEqual(w.sent, []);
  });

  // the high review of #553, 1: one fingerprint for both, re-baselined by the
  // templates' list, hid the resources' change
  it('its resources and its templates are each their own list: one listed after the other has changed still has its change told', () => {
    const w = world();
    w.listed('resources/list');
    w.lists['resources/list'] = 'R1';
    w.notices.changed();
    w.listed('resources/templates/list');
    w.settle();
    w.release();
    assert.deepStrictEqual(w.sent, [RESOURCES]);
  });

  it('both changed: one resources notice for the round', () => {
    const w = world();
    w.listed('resources/list');
    w.listed('resources/templates/list');
    w.lists['resources/list'] = 'R1';
    w.lists['resources/templates/list'] = 'T1';
    w.notices.changed();
    w.settle();
    w.release();
    assert.deepStrictEqual(w.sent, [RESOURCES]);
  });

  it('a change after its first page was asked for, before the answer: stale, so told after the settle', () => {
    const w = world();
    const t = w.notices.began('prompts/list');
    w.lists['prompts/list'] = 'P1';
    w.notices.changed();
    w.notices.answered(t, true);
    w.release();
    w.settle();
    w.release();
    assert.deepStrictEqual(w.sent, [PROMPTS]);
  });

  it('a change while its whole list is being taken: stale, so told after the settle', () => {
    const w = world();
    const t = w.notices.began('prompts/list');
    w.notices.answered(t, true);
    w.lists['prompts/list'] = 'P1';
    w.notices.changed();
    w.release();
    w.settle();
    w.release();
    assert.deepStrictEqual(w.sent, [PROMPTS]);
  });

  it('a list that could not be taken is stale, as an error answer is: the next change tells it', () => {
    const w = world();
    const t = w.notices.began('prompts/list');
    w.notices.answered(t, true);
    w.fail();
    const u = w.notices.began('resources/list');
    w.notices.answered(u, false);
    assert.deepStrictEqual(w.pending, [], 'an error answer takes nothing');
    w.notices.changed();
    w.settle();
    w.release();
    assert.deepStrictEqual(w.sent.slice().sort(), [PROMPTS, RESOURCES].sort());
  });

  it('a comparison that meets the client listing again lets the client\'s own take decide: nothing told for a list it has', () => {
    const w = world();
    w.listed('prompts/list');
    w.lists['prompts/list'] = 'P1';
    w.notices.changed();
    w.settle();
    // the comparison's list is asked for; the client lists before it comes back
    const t = w.notices.began('prompts/list');
    w.notices.answered(t, true);
    w.release();
    w.settle();
    w.release();
    assert.deepStrictEqual(w.sent, []);
  });

  it('reset (the client went on in 2026-07-28): nothing it listed is followed any more', () => {
    const w = world();
    w.listed('prompts/list');
    w.notices.reset();
    w.lists['prompts/list'] = 'P1';
    w.notices.changed();
    w.settle();
    w.release();
    assert.deepStrictEqual(w.sent, []);
  });

  it('a method it does not follow is no token, and answering none does nothing', () => {
    const w = world();
    assert.strictEqual(w.notices.began('tools/list'), null);
    w.notices.answered(null, true);
    assert.deepStrictEqual(w.pending, []);
  });
});
