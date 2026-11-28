'use strict';
// A failure that came back as a bare DEVICE_INVOKE_EXCEPTION
// says why, from what the main thread itself knows, never from worker text:
//  - the runtime's own fixed worker-side reasons cross, on an exact match only;
//  - the refusal the main thread gave one of the call's module calls is kept on
//    the outer call (call-tokens) and said in the answer, by code, never naming
//    the other module or a remote's own words;
//  - the runtime's own failure classes are logged without --debug, bounded per
//    tool, with a line saying what the bound left out.
const assert = require('assert');
const {CountinghouseError} = require('../../lib/countinghouse-error');
const callTokens = require('../../lib/call-tokens');

describe('validation 39: a bare DEVICE_INVOKE_EXCEPTION says why', () => {
  // (the runtime's one log, made by any test that reaches it, is reset after)
  after(() => require('../../lib/failed-call-log').resetRuntimeLog());
  const HEAD = new CountinghouseError('DEVICE_INVOKE_EXCEPTION').message;

  describe('the runtime\'s own worker-side reasons cross on an exact match', () => {
    // (as the runtime raises one: new CountinghouseError(code, reason), its message "<head>: <reason>")
    const raised = (code, reason) => new CountinghouseError(code, reason).message;
    // (across a reply: the worker's fields, decoded on the main thread)
    const across = (err) => CountinghouseError.fromReply(CountinghouseError.fromReplyFields(CountinghouseError.replyFields(err)));
    it('one of the closed list crosses with its reason, raised by the runtime (its mark crosses the reply)', () => {
      for (const reason of CountinghouseError.WORKER_REASONS) {
        assert.strictEqual(across(CountinghouseError.runtimeReason('DEVICE_INVOKE_EXCEPTION', reason)).message, raised('DEVICE_INVOKE_EXCEPTION', reason), reason);
      }
    });
    it('the same words built as a handler\'s untyped throw is built (lib/handler-answer.js), unmarked, stay the bare head', () => {
      for (const reason of CountinghouseError.WORKER_REASONS) assert.strictEqual(across(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', reason)).message, HEAD, reason);
    });
    it('on the peer path too: the mark crosses a callee\'s port refusal and a main refusal the caller\'s worker is handed', () => {
      const reason = 'a hop\'s input could not be read';
      const wire = CountinghouseError.replyFields(CountinghouseError.runtimeReason('DEVICE_INVOKE_EXCEPTION', reason));
      // (the caller's end of the port: lib/peer-channel.js)
      const PeerChannel = require('../../lib/peer-channel');
      let got = null;
      const end = Object.create(PeerChannel.prototype);
      end.pending = {7: {}}; end._settle = (id, err) => { got = err; };
      end._handleReply(Object.assign({id: 7, category: 'peer-reply', data: null}, wire));
      assert.strictEqual(CountinghouseError.fromReply(got).message, raised('DEVICE_INVOKE_EXCEPTION', reason));
      // (the caller's worker, handed main's answer: lib/peer-worker.js)
      const {methods, registerPeerMaps} = require('../../lib/peer-worker');
      let delivered = null;
      const state = {};
      registerPeerMaps(state, {peerChannels: {5: {epoch: 1, deliver: (id, err) => { delivered = err; }}}});
      methods.onPeerResult.call(state, Object.assign({channel: 'c:5', epoch: 1, invokeId: 1}, wire));
      assert.strictEqual(CountinghouseError.fromReply(delivered).message, raised('DEVICE_INVOKE_EXCEPTION', reason));
      // (unmarked, the same words stay the bare head on both)
      const plain = {errMsg: raised('DEVICE_INVOKE_EXCEPTION', reason), errCode: 'DEVICE_INVOKE_EXCEPTION'};
      end.pending = {8: {}}; end._handleReply(Object.assign({id: 8, category: 'peer-reply', data: null}, plain));
      assert.strictEqual(CountinghouseError.fromReply(got).message, HEAD);
    });
    it('the closed list', () => {
      for (const r of ['a module\'s result could not be read', 'the error could not be sent between threads', 'the value could not be sent between threads']) assert.ok(CountinghouseError.WORKER_REASONS.includes(r), r);
    });
    it('a handler\'s own throw of the same words never crosses as the runtime\'s reason (it carries the from-handler mark)', () => {
      const thrown = require('../../lib/countinghouse-error').markFromHandler(new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a module\'s result could not be read'));
      const decoded = CountinghouseError.fromReplyFields(CountinghouseError.replyFields(thrown));
      assert.strictEqual(CountinghouseError.fromReply(decoded).message, HEAD);
      // (a runtime raise that a handler threw on keeps its from-handler mark: its words are not the runtime's)
      const passedOn = require('../../lib/countinghouse-error').markFromHandler(CountinghouseError.runtimeReason('DEVICE_INVOKE_EXCEPTION', 'a module\'s result could not be read'));
      assert.strictEqual(across(passedOn).message, HEAD);
    });
    it('a near match, another code\'s head or a forged text is rebuilt from the code alone', () => {
      const r = 'a module\'s result could not be read';
      const real = raised('DEVICE_INVOKE_EXCEPTION', r);
      for (const message of [`${real}!`, `${HEAD}:  ${r}`, `${HEAD} ${r}`, `${real} and more`, `x ${real}`, `${HEAD}. Before it failed, the runtime refused its call to another module: DEVICE_NOT_FOUND.`]) {
        assert.strictEqual(CountinghouseError.fromReply({code: 'DEVICE_INVOKE_EXCEPTION', message}).message, HEAD, message);
      }
      const fail = new CountinghouseError('DEVICE_INVOKE_FAIL').message;
      assert.strictEqual(CountinghouseError.fromReply({code: 'DEVICE_INVOKE_FAIL', message: raised('DEVICE_INVOKE_FAIL', r)}).message, fail);
    });
  });

  describe('the answer says the refusal the runtime gave before the failure', () => {
    it('a crash or a failure after a module call the runtime refused: one line, the code, never the module', () => {
      const e = CountinghouseError.withRefusal(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), {code: 'DEVICE_NOT_FOUND', to: 'module'});
      assert.strictEqual(e.message, `${HEAD}. Before it failed, the runtime refused its call to another module: DEVICE_NOT_FOUND.`);
      assert.deepStrictEqual(e.refusedBefore, {code: 'DEVICE_NOT_FOUND', to: 'module'});
      assert.ok(!Object.keys(e).includes('refusedBefore'), 'not enumerable: never sent as a field');
      const r = CountinghouseError.withRefusal(new CountinghouseError('DEVICE_INVOKE_FAIL'), {code: 'REMOTE_TIMEOUT', to: 'remote'});
      assert.ok(r.message.endsWith('. Before it failed, the runtime refused its call to a remote service: REMOTE_TIMEOUT.'), r.message);
    });
    it('a code about the calling module\'s own call is said as it is; any other (a part\'s state) is DEVICE_NOT_FOUND, the log keeping the exact code', () => {
      for (const code of ['CTX_CALL_NOT_READY', 'CTX_CALL_UNDECLARED', 'HOP_CHAIN_TOO_DEEP', 'USAGE_CALL_FOREIGN', 'INPUT_TOO_LARGE', 'OUTPUT_TOO_LARGE', 'SETTING_REQUIRED', 'SETTING_NOT_READY',
        'INPUT_DATA_VALIDATION_FAIL', 'OUTPUT_DATA_VALIDATION_FAIL', 'VALIDATION_TIMEOUT', 'VALIDATION_CALLER_THROTTLED',
        // (the call's own input or the answer's shape, as main's validators and checks give them)
        'MISSING_OUTPUT_ARGUMENT', 'ARGUMENTS_INVALID', 'ACTION_NOT_FOUND', 'SERVICE_NOT_FOUND', 'INPUT_NOT_FOUND', 'ACTION_NOT_IMPLEMENTED']) {
        assert.ok(CountinghouseError.withRefusal(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), {code, to: 'module'}).message.endsWith(`: ${code}.`), code);
      }
      assert.ok(CountinghouseError.withRefusal(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), {code: 'REMOTE_UNDECLARED', to: 'remote'}).message.endsWith(': REMOTE_UNDECLARED.'));
      // (a remote's refusal is never said as a missing module)
      assert.ok(!/DEVICE_NOT_FOUND/.test(CountinghouseError.withRefusal(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), {code: 'CTX_CALL_NOT_READY', to: 'remote'}).message));
      // (a module's validation quarantine is that module's state, held until an operator reloads it)
      for (const code of ['MODULE_UNLOADED', 'MODULE_RELOADING', 'MODULE_NOT_LISTED', 'DEVICE_NOT_FOUND', 'MODULE_RESTARTING', 'MODULE_SUSPENDED', 'SESSION_WORKER_ENDED', 'SESSION_WORKERS_BUSY', 'MODULE_SESSION_PAUSED', 'VALIDATION_QUARANTINED']) {
        const e = CountinghouseError.withRefusal(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), {code, to: 'module'});
        assert.strictEqual(e.message, `${HEAD}. Before it failed, the runtime refused its call to another module: DEVICE_NOT_FOUND.`, code);
        assert.deepStrictEqual(e.refusedBefore, {code, to: 'module'}, 'the log keeps the exact code');
      }
    });
    it('every catalogue code the CTX_CALL_ and HOP_ prefixes let through is listed here: a new one is said as it is only by choice', () => {
      const {CODES} = require('../../lib/error-catalogue');
      const through = Object.keys(CODES).filter((c) => c.startsWith('CTX_CALL_') || c.startsWith('HOP_')).sort();
      assert.deepStrictEqual(through, ['CTX_CALL_BAD_ADDRESS', 'CTX_CALL_NOT_READY', 'CTX_CALL_UNBOUND', 'CTX_CALL_UNDECLARED', 'CTX_CALL_UNRESOLVED', 'HOP_CHAIN_TOO_DEEP', 'HOP_IDENTITY_UNRESOLVED'].sort(), JSON.stringify(through));
    });
    it('anything else is left as it was: another code, a module\'s error, no refusal, a code of another form', () => {
      const keep = (err, refused) => { const m = err.message; assert.strictEqual(CountinghouseError.withRefusal(err, refused).message, m); };
      keep(new CountinghouseError('DEVICE_NOT_FOUND'), {code: 'CTX_CALL_NOT_READY', to: 'module'});
      keep(CountinghouseError.module('MY_OWN', 'mine'), {code: 'DEVICE_NOT_FOUND', to: 'module'});
      keep(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), null);
      keep(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), {code: 'not a code', to: 'module'});
      keep(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), {code: 'DEVICE_NOT_FOUND', to: 'elsewhere'});
    });
  });

  describe('a call keeps the runtime\'s refusal of its own last module call', () => {
    const W = 'w-38';
    const issue = (parent = null, workerId = W) => callTokens.issue({billingKey: 'k', workerId, deviceID: 'd', parent});
    it('its own call\'s refusal is kept on its own entry; a nested callee\'s refusal is the callee\'s, never its caller\'s', () => {
      const outer = issue(); const child = issue(outer, 'w-38b');
      assert.strictEqual(callTokens.refusedOf(outer), null);
      callTokens.noteRefused(child, 'CTX_CALL_NOT_READY', 'module', 'w-38b');
      assert.strictEqual(callTokens.refusedOf(outer), null, 'the callee\'s own refusal is not its caller\'s');
      assert.deepStrictEqual(callTokens.refusedOf(child), {code: 'CTX_CALL_NOT_READY', to: 'module'});
      callTokens.noteRefused(outer, 'DEVICE_NOT_FOUND', 'module', W);
      assert.deepStrictEqual(callTokens.refusedOf(outer), {code: 'DEVICE_NOT_FOUND', to: 'module'});
      callTokens.drop(outer); assert.strictEqual(callTokens.refusedOf(outer), null);
    });
    it('a later call that goes through clears it: a refusal the module recovered from is never said', () => {
      const outer = issue();
      callTokens.noteRefused(outer, 'DEVICE_NOT_FOUND', 'module', W);
      callTokens.noteThrough(outer, 'another-worker');
      assert.notStrictEqual(callTokens.refusedOf(outer), null, 'another worker\'s claim clears nothing');
      callTokens.noteThrough(outer, W);
      assert.strictEqual(callTokens.refusedOf(outer), null);
      callTokens.drop(outer);
    });
    it('a remote that sends the size marker in its own error: no sentence (the marker is a public string)', () => {
      const {McpError} = require('@modelcontextprotocol/sdk/types.js');
      const {TOO_LARGE} = require('../../lib/remote/fetch');
      const code = require('../../lib/remote/client').codeFor(new McpError(-32000, 'the remote says so', {marker: TOO_LARGE}));
      assert.strictEqual(code, 'REMOTE_RESULT_TOO_LARGE');
      const o = issue(); callTokens.noteRefused(o, code, 'remote', W);
      const said = CountinghouseError.withRefusal(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), callTokens.refusedOf(o));
      assert.strictEqual(said.message, HEAD); callTokens.drop(o);
    });
    it('the peer broker\'s denials: a refusal is noted, never the caller\'s own worker as its target, nor a route through the main thread', () => {
      const {deniedCode} = require('../../lib/peer-channel-broker');
      assert.strictEqual(deniedCode({errCode: 'DEVICE_ACCESS_ERROR', errMsg: 'x'}), 'DEVICE_ACCESS_ERROR');
      assert.strictEqual(deniedCode({errCode: 'PEER_SELF_TARGET', errMsg: 'x'}), null);
      assert.strictEqual(deniedCode({route: 'main', errCode: 'PEER_CHANNEL_DENIED', errMsg: 'x'}), null);
    });
    it('a later call that failed but was not refused (a callee\'s crash, a code not the catalogue\'s) clears it too', () => {
      for (const [code, to] of [['DEVICE_INVOKE_EXCEPTION', 'module'], ['A_REMOTES_OWN_CODE', 'remote']]) {
        const outer = issue();
        callTokens.noteRefused(outer, 'DEVICE_NOT_FOUND', 'module', W);
        callTokens.noteRefused(outer, code, to, W);
        assert.strictEqual(callTokens.refusedOf(outer), null, code);
        callTokens.drop(outer);
      }
    });
    it('a device query\'s answer: an error with its code is kept, an error without one clears nothing, a found device clears', () => {
      const WorkerMessage = require('../../lib/worker-message');
      const outer = issue();
      const wm = {queried: new Map(), workerId: W, sendMessageToWorker() {}};
      const answer = (msgID, fields) => { wm.queried.set(msgID, outer); WorkerMessage.prototype.sendDeviceQueryReplyToChild.call(wm, Object.assign({msgID}, fields)); };
      answer(1, Object.assign({spec: null}, CountinghouseError.replyFields(new CountinghouseError('DEVICE_NOT_FOUND', 'd'))));
      assert.deepStrictEqual(callTokens.refusedOf(outer), {code: 'DEVICE_NOT_FOUND', to: 'module'});
      // (the main thread's own code for an answer whose wire form is its text alone: noted, never sent)
      callTokens.noteThrough(outer, W);
      wm.queried.set(9, outer);
      let sent = null; wm.sendMessageToWorker = (m) => { sent = m; };
      WorkerMessage.prototype.sendDeviceQueryReplyToChild.call(wm, {msgID: 9, errMsg: new CountinghouseError('DEVICE_NOT_FOUND', 'd').message, spec: null}, 'DEVICE_NOT_FOUND');
      assert.deepStrictEqual(callTokens.refusedOf(outer), {code: 'DEVICE_NOT_FOUND', to: 'module'});
      assert.ok(sent != null && sent.errCode === undefined && !JSON.stringify(sent).includes('refusedCode'), 'the wire form is as before');
      answer(2, {errMsg: 'a text with no code', spec: null});
      assert.deepStrictEqual(callTokens.refusedOf(outer), {code: 'DEVICE_NOT_FOUND', to: 'module'}, 'an error answer is never a call that went through');
      answer(3, {spec: {device: {}}});
      assert.strictEqual(callTokens.refusedOf(outer), null);
      callTokens.drop(outer);
    });
    it('a part\'s token dropped: main\'s own note on it passes to its caller\'s call, unless that call holds one of its own', () => {
      const outer = issue(); const part = issue(outer, 'w-38b');
      callTokens.noteRefused(part, 'DEVICE_NOT_FOUND', 'module', 'w-38b');
      callTokens.drop(part);
      assert.deepStrictEqual(callTokens.refusedOf(outer), {code: 'DEVICE_NOT_FOUND', to: 'module', further: true});
      const outer2 = issue(); const part2 = issue(outer2, 'w-38b');
      callTokens.noteRefused(outer2, 'OUTPUT_TOO_LARGE', 'module', W);
      callTokens.noteRefused(part2, 'DEVICE_NOT_FOUND', 'module', 'w-38b');
      callTokens.drop(part2);
      assert.deepStrictEqual(callTokens.refusedOf(outer2), {code: 'OUTPUT_TOO_LARGE', to: 'module'}, 'the call\'s own refusal stays');
      // (only the token dropped passes its note up, never its descendants dropped with it)
      const outer3 = issue(); const part3 = issue(outer3, 'w-38b'); const deep = issue(part3, 'w-38c');
      callTokens.noteRefused(deep, 'CTX_CALL_NOT_READY', 'module', 'w-38c');
      callTokens.drop(part3);
      assert.strictEqual(callTokens.refusedOf(outer3), null);
      for (const t of [outer, outer2, outer3]) callTokens.drop(t);
    });
    it('a part\'s note does not pass up once its caller has moved on: a later call of the caller\'s went through, or one was refused', () => {
      const a = issue(); const pa = issue(a, 'w-38b');
      callTokens.noteRefused(pa, 'DEVICE_NOT_FOUND', 'module', 'w-38b');
      callTokens.noteThrough(a, W);
      callTokens.drop(pa);
      assert.strictEqual(callTokens.refusedOf(a), null, 'a call of the caller\'s went through after the part began: its note is older');
      const b = issue(); const pb = issue(b, 'w-38b');
      callTokens.noteRefused(pb, 'DEVICE_NOT_FOUND', 'module', 'w-38b');
      callTokens.noteRefused(b, 'REMOTE_TIMEOUT', 'remote', W);
      callTokens.drop(pb);
      assert.strictEqual(callTokens.refusedOf(b), null, 'cleared by the caller\'s own later call, never refilled by the part');
      for (const t of [a, b]) callTokens.drop(t);
    });
    it('a refusal further down reads as another module\'s, DEVICE_NOT_FOUND, whatever it was (a remote\'s, a throttle): the log keeps it exactly', () => {
      for (const [code, to] of [['REMOTE_UNDECLARED', 'remote'], ['VALIDATION_CALLER_THROTTLED', 'module'], ['CTX_CALL_NOT_READY', 'module']]) {
        const e = CountinghouseError.withRefusal(new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), {code, to, further: true});
        assert.strictEqual(e.message, `${HEAD}. Before it failed, the runtime refused its call to another module: DEVICE_NOT_FOUND.`, code);
        assert.deepStrictEqual(e.refusedBefore, {code, to, further: true});
      }
    });
    it('a remote\'s own failure (unreachable, a timeout) is not the runtime\'s refusal: not kept, and it clears an earlier one', () => {
      // (the runtime's own refusals of a remote call are kept, runtime kind or not)
      for (const code of ['HOP_IDENTITY_UNRESOLVED']) {
        const o = issue(); callTokens.noteRefused(o, code, 'remote', W);
        assert.deepStrictEqual(callTokens.refusedOf(o), {code, to: 'remote'}, code); callTokens.drop(o);
      }
      // (REMOTE_RESULT_TOO_LARGE among them: a remote can send its marker in its own error, so it is never said as the runtime's)
      for (const code of ['REMOTE_UNREACHABLE', 'REMOTE_TIMEOUT', 'REMOTE_AUTH_FAILED', 'REMOTE_PROTOCOL', 'REMOTE_RESULT_TOO_LARGE']) {
        const o = issue(); callTokens.noteRefused(o, 'REMOTE_UNDECLARED', 'remote', W); callTokens.noteRefused(o, code, 'remote', W);
        assert.strictEqual(callTokens.refusedOf(o), null, code); callTokens.drop(o);
      }
      const outer = issue();
      callTokens.noteRefused(outer, 'REMOTE_UNDECLARED', 'remote', W);
      assert.deepStrictEqual(callTokens.refusedOf(outer), {code: 'REMOTE_UNDECLARED', to: 'remote'});
      callTokens.noteRefused(outer, 'REMOTE_TIMEOUT', 'remote', W);
      assert.strictEqual(callTokens.refusedOf(outer), null);
      callTokens.drop(outer);
    });
    it('another worker\'s claim, a token not live, a module\'s code, a crash\'s own class: never kept', () => {
      const outer = issue();
      callTokens.noteRefused(outer, 'DEVICE_NOT_FOUND', 'module', 'another-worker');
      callTokens.noteRefused('not-a-token', 'DEVICE_NOT_FOUND', 'module', W);
      for (const code of ['MY_OWN_CODE', 'DEVICE_INVOKE_EXCEPTION', 'DEVICE_INVOKE_FAIL', 7, null]) callTokens.noteRefused(outer, code, 'module', W);
      callTokens.noteRefused(outer, 'DEVICE_NOT_FOUND', 'nowhere', W);
      assert.strictEqual(callTokens.refusedOf(outer), null);
      callTokens.drop(outer);
    });
  });

  describe('the runtime\'s own failure classes are logged without --debug, bounded per tool', () => {
    const make = (n = 2, windowMs = 1000) => {
      const lines = []; const timers = []; let t = Date.parse('2030-01-01T10:00:00Z');
      const log = require('../../lib/failed-call-log').createFailedCallLog({write: (l) => lines.push(l), now: () => t, n, windowMs,
        setTimer: (fn, ms) => { const x = {fn, at: t + ms}; timers.push(x); return x; }, clearTimer: (x) => { x.fn = null; }});
      return {log, lines, advance: (ms) => { t += ms; for (const x of timers.splice(0)) { if (x.fn != null && x.at <= t) x.fn(); else if (x.fn != null) timers.push(x); } }};
    };
    it('the line: the tool, the code, its class, and the runtime\'s refusal when there was one; nothing else', () => {
      const {log, lines} = make();
      log.failed('pack/triage', new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), {code: 'DEVICE_NOT_FOUND', to: 'module'});
      log.failed('pack/triage', new CountinghouseError('CTX_CALL_NOT_READY'));
      // (a caller's, a module's or an operator's code is not the runtime's failure: not logged)
      for (const code of ['DEVICE_NOT_FOUND', 'RATE_LIMIT_EXCEEDED', 'CTX_CALL_UNDECLARED', 'MODULE_UNLOADED']) log.failed('pack/triage', new CountinghouseError(code));
      assert.deepStrictEqual(lines, ['a call failed: pack/triage: DEVICE_INVOKE_EXCEPTION (the module crashed), after the runtime refused its call to another module: DEVICE_NOT_FOUND',
        'a call failed: pack/triage: CTX_CALL_NOT_READY (a runtime error)']);
    });
    it('a module\'s own answer, or no error, is the module\'s own: not logged', () => {
      const {log, lines} = make();
      log.failed('pack/triage', CountinghouseError.module('MY_OWN', 'mine'));
      log.failed('pack/triage', null);
      // (a runtime code a handler passed on carries the from-handler mark: the module's, not the runtime's)
      log.failed('pack/triage', {code: 'CTX_CALL_NOT_READY', fromHandler: true});
      assert.deepStrictEqual(lines, []);
      // (a refusal is read as the object's own fields only: an inherited one is no refusal)
      log.failed('pack/triage', new CountinghouseError('DEVICE_INVOKE_EXCEPTION'), Object.create({code: 'DEVICE_NOT_FOUND', to: 'module'}));
      assert.deepStrictEqual(lines, ['a call failed: pack/triage: DEVICE_INVOKE_EXCEPTION (the module crashed)']);
    });
    it('a burst of 7, then silence: 5 lines, then exactly one line at the window\'s end saying 2 were left out', () => {
      const {log, lines, advance} = make(5, 600000);
      for (let i = 0; i < 7; i++) { log.failed('pack/triage', new CountinghouseError('DEVICE_INVOKE_EXCEPTION')); advance(1000); }
      assert.strictEqual(lines.length, 5);
      advance(600000);
      assert.deepStrictEqual(lines.slice(5), ['…and 2 more failed calls of pack/triage not logged since 2030-01-01T10:00:05.000Z']);
      advance(600000);
      assert.strictEqual(lines.length, 6, 'said once');
    });
    it('closing (a graceful exit) says what is left out now, once', () => {
      const {log, lines} = make(1, 600000);
      for (let i = 0; i < 3; i++) log.failed('pack/triage', new CountinghouseError('DEVICE_INVOKE_EXCEPTION'));
      log.closeAll(); log.closeAll();
      assert.deepStrictEqual(lines.slice(1), ['…and 2 more failed calls of pack/triage not logged since 2030-01-01T10:00:00.000Z']);
    });
    it('the tool is the module the runtime loaded and an action its spec declares, never a request\'s name', () => {
      const {toolOf} = require('../../lib/failed-call-log');
      const spec = (name, actions) => ({device: {friendlyName: name, serviceList: {'urn:x:serviceID:s': {actionList: actions.map((a) => ({name: a}))}}}});
      // (a worker's WorkerMessage: its devices' specs by id; a device in single-thread mode: its own spec)
      assert.strictEqual(toolOf({moduleName: 'pack', deviceList: {d1: spec('pack', ['triage'])}}, 'triage', 'd1'), 'pack/triage');
      assert.strictEqual(toolOf({hostModuleName: 'host', deviceList: {d2: spec('host', ['run'])}}, 'run', 'd2'), 'host/run');
      assert.strictEqual(toolOf({spec: spec('single', ['go'])}, 'go', 'd3'), 'single/go');
      // (a scoped module, as a module's data folder allows one)
      assert.strictEqual(toolOf({moduleName: '@acme/pack', deviceList: {d4: spec('@acme/pack', ['triage'])}}, 'triage', 'd4'), '@acme/pack/triage');
      for (const [device, action, id] of [[null, 'a', 'd'], [{}, 'a', 'd'], [{moduleName: 'm', deviceList: {d: spec('m', ['a'])}}, null, 'd'],
        [{moduleName: 'm', deviceList: {d: spec('m', ['a'])}}, 'made-up', 'd'], [{moduleName: 'm', deviceList: {d: spec('m', ['a'])}}, 'a', 'other'],
        [{moduleName: 'm\nx', deviceList: {d: spec('m', ['a'])}}, 'a', 'd'], [{moduleName: 'm'}, 'a', 'd']]) {
        assert.strictEqual(toolOf(device, action, id), null, JSON.stringify([device, action, id]));
      }
    });
    it('with every tool slot in use, a new tool closes the oldest window, its line said, never a failure dropped unsaid', () => {
      const lines = []; let t = 0;
      const log = require('../../lib/failed-call-log').createFailedCallLog({write: (l) => lines.push(l), now: () => t, n: 1, windowMs: 1e9, maxTools: 2, setTimer: () => ({}), clearTimer: () => {}});
      for (const tool of ['a/x', 'a/x', 'b/x']) { log.failed(tool, new CountinghouseError('DEVICE_INVOKE_EXCEPTION')); t += 1; }
      log.failed('c/x', new CountinghouseError('DEVICE_INVOKE_EXCEPTION'));
      assert.deepStrictEqual(lines, ['a call failed: a/x: DEVICE_INVOKE_EXCEPTION (the module crashed)', 'a call failed: b/x: DEVICE_INVOKE_EXCEPTION (the module crashed)',
        '…and 1 more failed calls of a/x not logged since 1970-01-01T00:00:00.001Z', 'a call failed: c/x: DEVICE_INVOKE_EXCEPTION (the module crashed)']);
    });
    it('the first n in a window, then one line saying how many were left out, at the window\'s end', () => {
      const {log, lines, advance} = make(2, 1000);
      for (let i = 0; i < 5; i++) { log.failed('pack/triage', new CountinghouseError('DEVICE_INVOKE_EXCEPTION')); advance(10); }
      log.failed('other/tool', new CountinghouseError('DEVICE_INVOKE_FAIL'));
      assert.strictEqual(lines.length, 3, lines.join('\n'));
      advance(1000);
      assert.strictEqual(lines[3], '…and 3 more failed calls of pack/triage not logged since 2030-01-01T10:00:00.020Z');
      // (a new window starts logging again; nothing was left out of other/tool)
      log.failed('pack/triage', new CountinghouseError('DEVICE_INVOKE_EXCEPTION'));
      assert.strictEqual(lines.length, 5); assert.ok(!lines.some((l) => /more failed calls of other\/tool/.test(l)));
    });
  });
});
