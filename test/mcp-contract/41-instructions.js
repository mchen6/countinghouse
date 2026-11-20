'use strict';
// B-firstrun (the first-run design, (a); Matt's approval 11-20, business's
// claim check): the server's instructions are one fixed English paragraph,
// the runtime's own text -- nothing a module supplies -- the same for every
// caller, sent on initialize and on server/discover (cached public). This
// pins it, word for word: a change is a business review.
const assert = require('assert');
const gateway = require('../../lib/mcp/gateway');

const GOLDEN = 'This is countinghouse, a runtime that serves the tools of the modules installed on it. '
  + 'To learn what is installed here, what each pack does, example requests and anything still missing, call countinghouse_overview; it changes nothing. '
  + 'Where countinghouse_settings is offered, it reads and changes settings within their bounds. '
  + 'Turning a module on or loosening a limit needs the user\'s own confirmation; ask the user before changing any setting. '
  + 'Never ask the user for a credential, key or token, and never accept one in the conversation: '
  + 'when a module needs one, the overview names the command the user runs in their own terminal.';

const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': {name: 'instructions-test', version: '0'}};
const ask = (message, key = null) => new Promise((resolve, reject) => {
  gateway.handle(message, null, key, (err, res) => (err != null ? reject(err) : resolve(res)), {});
});

describe('mcp-contract 41: the server\'s instructions (B-firstrun)', () => {
  it('initialize and server/discover send the one fixed paragraph, word for word', async () => {
    const init = await ask({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 't', version: '0'}}});
    const disc = await ask({jsonrpc: '2.0', id: 2, method: 'server/discover', params: {_meta: META}});
    assert.strictEqual(init.result.instructions, GOLDEN);
    assert.strictEqual(disc.result.instructions, GOLDEN);
    assert.strictEqual(disc.result.cacheScope, 'public', 'discover is cached for everyone: the paragraph is the same for every caller');
  });

  it('the same for every caller, and about 600 characters of plain text', async () => {
    const a = await ask({jsonrpc: '2.0', id: 3, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'a', version: '0'}}}, 'key-a-0123456789');
    const b = await ask({jsonrpc: '2.0', id: 4, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'b', version: '1'}}}, null);
    assert.strictEqual(a.result.instructions, b.result.instructions);
    assert.ok(GOLDEN.length >= 500 && GOLDEN.length <= 700, String(GOLDEN.length));
    // (fixed runtime text: no character a client would have to clean)
    assert.ok(/^[\x20-\x7e]+$/.test(GOLDEN));
  });
});
