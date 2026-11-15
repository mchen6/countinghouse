'use strict';
// B1 Task 1 (docs/superpowers/plans/2026-11-15-shared-runtime-b1-sessions.md):
// lib/sessions.js, the main thread's per-session state, kept beside C1's
// registry (lib/session-transport/registry.js): each session's own
// clientInfo (its first initialize), its context for a request (P2's
// contextOf, per session), its repository default, and nothing once it
// ends. Driven through C1's real listener and its test shim, in-process.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createRegistry} = require('../../lib/session-transport/registry');
const {createListener} = require('../../lib/session-transport/listener');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');
const sessions = require('../../lib/sessions');

describe('sessions 01: each session\'s own state on the main thread (shared runtime B1, Task 1)', function() {
  this.timeout(30000);
  if (process.platform === 'win32') return;   // the named pipe is C2's
  let dir;
  let sock;
  let secret;
  let registry;
  let listener;
  beforeEach(async () => {
    sessions.resetForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-b1-'));
    sock = path.join(dir, 's');
    secret = handshake.newSecret();
    registry = createRegistry({reconnectWindowMs: 200});
    sessions.attach(registry);
    listener = createListener({path: sock, secret, registry, runtimeVersion: '8.0.0-test', maxToRuntime: 1 << 20, maxToShim: 1 << 20, tokenMac: null,
      onMessage: (s, message, reply) => { if (message.id !== undefined) reply({jsonrpc: '2.0', id: message.id, result: {}}); }});
    await listener.listen();
  });
  afterEach(async () => {
    if (listener != null) await listener.close();
    listener = null;
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const CC = (version) => ({name: 'claude-code', version});
  const FORM = {'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}};

  it('two sessions each keep their own first initialize, and contextOf answers each with its own client and id', async () => {
    const a = await shim.session(sock, secret);
    const b = await shim.session(sock, secret, {status: 'ok', conditions: 'yes', repo: 'octo/repo', token: null});
    const [sa, sb] = [a.welcome.session, b.welcome.session];
    assert.notStrictEqual(sa, sb);
    sessions.recordClientInfo(sa, CC('2.1.323'));
    sessions.recordClientInfo(sb, CC('2.1.400'));
    sessions.recordClientInfo(sa, CC('9.9.9'));   // a second initialize changes nothing
    // a legacy request: its session's own initialize, and no capabilities (no form)
    assert.deepStrictEqual(sessions.contextOf(sa, {_meta: FORM}, false), {clientInfo: CC('2.1.323'), capabilities: null, session: sa});
    assert.deepStrictEqual(sessions.contextOf(sb, {}, false), {clientInfo: CC('2.1.400'), capabilities: null, session: sb});
    // the repository default is the session's own, live from C1's client frame
    assert.strictEqual(sessions.repoOf(sa), null);
    assert.strictEqual(sessions.repoOf(sb), 'octo/repo');
    a.c.end();
    b.c.end();
  });

  it('a session\'s modern request: only its own _meta, never its session\'s initialize (#229)', async () => {
    const a = await shim.session(sock, secret);
    const sa = a.welcome.session;
    sessions.recordClientInfo(sa, CC('2.1.323'));
    const own = {'io.modelcontextprotocol/clientInfo': CC('2.1.500'), 'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}};
    assert.deepStrictEqual(sessions.contextOf(sa, {_meta: own}, true), {clientInfo: CC('2.1.500'), capabilities: {elicitation: {}}, session: sa});
    assert.deepStrictEqual(sessions.contextOf(sa, {_meta: FORM}, true), {clientInfo: null, capabilities: {elicitation: {}}, session: sa}, 'no client of its own: none, not the initialize\'s');
    assert.deepStrictEqual(sessions.contextOf(sa, {}, true), {clientInfo: null, capabilities: null, session: sa});
    a.c.end();
  });

  it('a session that ends leaves nothing: its state is gone, and an unknown id has none', async () => {
    const a = await shim.session(sock, secret);
    const id = a.welcome.session;
    sessions.recordClientInfo(id, CC('2.1.323'));
    assert.ok(sessions.get(id) != null);
    a.c.send('C', {op: 'bye'});
    for (let w = 0; sessions.get(id) != null && w < 3000; w += 20) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(sessions.get(id), null);
    for (const modern of [false, true]) assert.deepStrictEqual(sessions.contextOf(id, {_meta: FORM}, modern), {clientInfo: null, capabilities: null, session: null}, 'an ended or unknown session is none');
    assert.strictEqual(sessions.get('f'.repeat(32)), null);
  });

  it('a second attach of one registry adds nothing; a session is never re-opened over its state', async () => {
    sessions.attach(registry);   // again
    const a = await shim.session(sock, secret);
    const id = a.welcome.session;
    sessions.recordClientInfo(id, CC('2.1.323'));
    assert.deepStrictEqual(sessions.get(id).clientInfo, CC('2.1.323'), 'still the first initialize');
    a.c.end();
  });

  it('get() is a frozen view, never C1\'s session object; a caller cannot change what contextOf answers', async () => {
    const a = await shim.session(sock, secret);
    const id = a.welcome.session;
    sessions.recordClientInfo(id, CC('2.1.323'));
    const view = sessions.get(id);
    assert.ok(Object.isFrozen(view));
    assert.deepStrictEqual(Object.keys(view).sort(), ['clientInfo', 'id', 'repo']);
    assert.throws(() => { 'use strict'; view.clientInfo = null; });
    assert.deepStrictEqual(sessions.contextOf(id, {}).clientInfo, CC('2.1.323'));
    a.c.end();
  });
});

describe('sessions 01b: --stdio is one session (every OS)', () => {
  const clientInfo = require('../../lib/mcp/client-info');
  beforeEach(() => sessions.resetForTests());

  it('one session, its id fixed for the process (a reset keeps it)', () => {
    const id = sessions.openLocal();
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.ok(sessions.get(id) != null);
    assert.strictEqual(sessions.openLocal(), id);
    sessions.resetForTests();
    assert.strictEqual(sessions.openLocal(), id, 'the id P2\'s confirmations are bound to never changes');
  });

  it('client-info over it: its first initialize, contextOf (legacy and modern) with its id, --debug logs name and version once', () => {
    const options = require('../../lib/cli-options');
    const LOG = require('../../lib/logger');
    const logI = LOG.I;
    const lines = [];
    const debug = options.debug;
    LOG.I = (l) => { lines.push(String(l)); return l; };
    options.debug = true;
    try {
      clientInfo.record({name: 'claude-code', version: '2.1.323'});
      clientInfo.record({name: 'other', version: '1.0.0'});
      // legacy: the initialize's client, no capabilities
      const FORM = {'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}};
      assert.deepStrictEqual(clientInfo.contextOf({_meta: FORM}, false), {clientInfo: {name: 'claude-code', version: '2.1.323'}, capabilities: null, session: sessions.openLocal()});
      // modern: its own _meta only
      const own = Object.assign({'io.modelcontextprotocol/clientInfo': {name: 'claude-code', version: '2.1.400'}}, FORM);
      assert.deepStrictEqual(clientInfo.contextOf({_meta: own}, true), {clientInfo: {name: 'claude-code', version: '2.1.400'}, capabilities: {elicitation: {}}, session: sessions.openLocal()});
      assert.strictEqual(clientInfo.contextOf({_meta: FORM}, true).clientInfo, null, 'never the initialize\'s');
      assert.deepStrictEqual(lines.filter((l) => /^mcp: client/.test(l)), ['mcp: client "claude-code" "2.1.323"']);
    } finally {
      LOG.I = logI;
      options.debug = debug;
    }
  });

  it('a shared runtime\'s session acts only once its client frame is there', () => {
    const EventEmitter = require('events');
    const fake = new EventEmitter();
    fake.client = null;   // announced before its client frame (C1's fix makes this impossible)
    fake.id = 'a'.repeat(32);
    const reg = new EventEmitter();
    sessions.attach(reg);
    reg.emit('session', fake);
    assert.strictEqual(sessions.get(fake.id), null);
    assert.deepStrictEqual(sessions.contextOf(fake.id, {}), {clientInfo: null, capabilities: null, session: null});
    fake.client = {status: 'ok', conditions: 'yes', repo: null};
    assert.ok(sessions.get(fake.id) != null);
    fake.emit('end');
    assert.strictEqual(sessions.get(fake.id), null);
  });
});
