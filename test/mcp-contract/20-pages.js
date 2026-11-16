// MCP completeness M1, spec section 5: the page helper (lib/mcp/pages.js).
// A cursor is opaque base64url of {v: 1, k: kind, a: anchor}, at most 512
// bytes, unsigned: the list is derived again for its caller on every page,
// and the cursor is only a position in it. A keyset, not an offset: a page
// starts right after its anchor. Anything that names no position in this
// kind's list -- malformed, oversized, another kind's, an anchor no longer
// there -- is null, which the gateway answers with one -32602.
const assert = require('assert');
const {encodeCursor, decodeCursor, page, MAX_CURSOR_BYTES, MAX_ANCHOR_CHARS} = require('../../lib/mcp/pages');

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

describe('mcp-contract 20: the page helper (M1)', () => {
  it('a cursor round-trips its kind and anchor, and is base64url of the versioned JSON', () => {
    const c = encodeCursor('tools', 'echo_svc_echo');
    assert.match(c, /^[A-Za-z0-9_-]+$/);
    assert.deepStrictEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), {v: 1, k: 'tools', a: 'echo_svc_echo'});
    assert.strictEqual(decodeCursor('tools', c), 'echo_svc_echo');
    assert.strictEqual(MAX_CURSOR_BYTES, 512);
  });

  // The review of M1: a tool name is <device>_<service>_<action>, up to 64 +
  // 128 + 64 characters and a _<n> suffix, so the server must take back any
  // cursor it gives
  it('the longest name a module can give a tool round-trips, within 512 bytes', () => {
    const longest = `${'d'.repeat(64)}_${'s'.repeat(128)}_${'a'.repeat(64)}_9999`;
    const c = encodeCursor('tools', longest);
    assert.ok(c.length <= MAX_CURSOR_BYTES, `${c.length} bytes`);
    assert.strictEqual(decodeCursor('tools', c), longest);
    assert.ok(MAX_ANCHOR_CHARS >= longest.length);
  });

  it('anything that is no cursor of this kind is null', () => {
    const good = {v: 1, k: 'tools', a: 'x'};
    for (const [why, cursor] of [
      ['not a string', 42], ['null', null], ['empty', ''], ['not base64url', 'a+b/c='], ['not JSON', Buffer.from('nope').toString('base64url')],
      ['an extra key', b64(Object.assign({}, good, {o: 3}))], ['a missing key', b64({v: 1, k: 'tools'})], ['another version', b64(Object.assign({}, good, {v: 2}))],
      ['another kind', b64(Object.assign({}, good, {k: 'resources'}))], ['an anchor that is no string', b64(Object.assign({}, good, {a: 7}))],
      ['an anchor too long', b64(Object.assign({}, good, {a: 'x'.repeat(MAX_ANCHOR_CHARS + 1)}))],
      ['over 512 bytes', 'A'.repeat(MAX_CURSOR_BYTES + 1)], ['a JSON array', b64([1, 'tools', 'x'])]
    ]) assert.strictEqual(decodeCursor('tools', cursor), null, why);
  });

  it('a page is a keyset: it starts right after its anchor, and says where the next one starts', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    assert.deepStrictEqual(page(keys, undefined, 2), {from: 0, to: 2, next: 'b'});
    assert.deepStrictEqual(page(keys, 'b', 2), {from: 2, to: 4, next: 'd'});
    assert.deepStrictEqual(page(keys, 'd', 2), {from: 4, to: 5, next: null}, 'the last page has no next');
    assert.deepStrictEqual(page(keys, undefined, 5), {from: 0, to: 5, next: null}, 'a list that fits is one page');
    assert.deepStrictEqual(page([], undefined, 5), {from: 0, to: 0, next: null});
  });

  it('an anchor not in the list is null: no page, never a guess', () => {
    assert.strictEqual(page(['a', 'b'], 'z', 2), null);
    assert.strictEqual(page([], 'a', 2), null);
  });

  it('a page resumes after an item still there, though items before it changed', () => {
    assert.deepStrictEqual(page(['new', 'a', 'b', 'c'], 'b', 2), {from: 3, to: 4, next: null});
  });
});
