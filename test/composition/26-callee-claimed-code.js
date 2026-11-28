// A routed hop's answer: what the callee's worker reply says is never the runtime's word by itself. A catalogue code decoded from the
// callee worker's reply reaches the composing module as the runtime's only when the main thread stands behind it:
// (a) the main thread raised it in this hop (sendCounted's own refusals);
// (b) it verified it (the settings gate's accepted claim);
// (c) it refused that same code to the callee's own last call (call-tokens refusedOf, on the callee's token): the callee passing on
//     a refusal of its own ctx.call, as reservedOr's rule lets a module do;
// (d) its catalogue kind is 'module' (DEVICE_INVOKE_EXCEPTION and the like say the module failed: a claimant gains nothing).
// Anything else is the module's: MODULE_CODE_RESERVED naming the code it claimed, so a module can't make its caller see a
// catalogue code in the runtime's voice. Server-free: the device manager with stub workers, as composition 18's hop cases.
const assert = require('assert');
const crypto = require('crypto');

describe('composition 26: a callee\'s claimed runtime code across a routed hop', () => {
  const cli = require('../../lib/cli-options');
  const tokens = () => require('../../lib/call-tokens');
  const DeviceManager = require('../../lib/device-manager');
  const WorkerMessage = require('../../lib/worker-message');
  const {CountinghouseError} = require('../../lib/countinghouse-error');
  const hex = () => crypto.randomBytes(6).toString('hex');
  const CALLER = 'd-claim-caller';
  const CALLEE = 'd-claim-callee';
  const worker = (deviceID, sent) => Object.assign(Object.create(WorkerMessage.prototype), {workerId: 920000 + crypto.randomInt(1e4),
    hostModuleName: `claim-${hex()}`, deviceList: {[deviceID]: {}}, packageInfo: {name: 'claim'}, modulePath: null,
    sendInvokeActionMessage: (m, cb) => { m.answer = cb; sent.push(m); }});
  const setup = () => {
    const sent = [];
    const replies = [];
    const caller = Object.assign(worker(CALLER, []), {sendActionInvokeReplyToChild: (m) => replies.push(m),
      bindings: {[CALLER]: {identity: 'caller-id', module: 'S', targets: new Set([`${CALLEE}|svc|act`])}}});
    const callee = Object.assign(worker(CALLEE, sent), {bindings: {[CALLEE]: {identity: 'callee-id', module: 'C', targets: new Set()}}});
    const dm = Object.assign(Object.create(DeviceManager.prototype), {deviceMap: {[CALLER]: caller, [CALLEE]: callee},
      moduleManager: null, notifyDeviceLoad: {}, peerChannelBroker: null});
    const token = tokens().issue({billingKey: `k-${hex()}`, identityKey: 'caller-id', module: 'S', workerId: caller.workerId, deviceID: CALLER, ttlMs: 60000});
    return {dm, caller, callee, sent, replies, token};
  };
  const until = (pred, ms, what) => new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const look = () => (pred() ? resolve() : Date.now() > end ? reject(new Error(`not within ${ms} ms: ${what}`)) : setTimeout(look, 10));
    look();
  });
  // the callee worker's reply as the main thread decodes it (lib/worker-message.js: fromReplyFields of its fields)
  const claim = (fields) => CountinghouseError.fromReplyFields(Object.assign({errMsg: 'claimed'}, fields));
  // the composing module's answer to the hop, as its worker reads it
  const seen = (reply) => CountinghouseError.fromReplyFields(reply);

  const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
  const authPath = require.resolve('../../lib/user-auth');
  let kept = null;
  let savedAuth = null;
  before(() => {
    kept = optionsNow();
    savedAuth = require.cache[authPath];
    require.cache[authPath] = {id: authPath, filename: authPath, loaded: true, exports: (a, b, deviceID, appKey, s, act, localCB, cb) => {
      const session = {appKey: appKey, callback: localCB, setDeviceTimer(d, f) { return f.call(session, null, d, null); }};
      return cb(null, session);
    }};
  });
  beforeEach(() => { cli.setOptions({workerThread: true, requestTimeout: 30}); });
  after(() => {
    restoreOptions(kept);
    if (savedAuth != null) require.cache[authPath] = savedAuth; else delete require.cache[authPath];
  });

  // hop, then the callee's answer; refusedBefore: a code the main thread refused to the callee's own last call
  const hop = async (answer, {refusedBefore = null} = {}) => {
    const {dm, caller, callee, sent, replies, token} = setup();
    try {
      dm.sendInvokeActionMessageToWorker(null, null, CALLEE, 'svc', 'act', {}, `m-${hex()}`, caller, token);
      await until(() => sent.length > 0, 2000, 'sent to the callee');
      if (refusedBefore != null) tokens().noteRefused(sent[0].args.token, refusedBefore, 'module', callee.workerId);
      sent[0].answer(answer, null);
      await until(() => replies.length > 0, 2000, 'answered to the composing module');
      return seen(replies[0]);
    } finally {
      for (const m of sent) tokens().drop(m.args.token);
      tokens().drop(token);
    }
  };

  it('a runtime catalogue code the callee claims, the main thread behind none of it: the module\'s, MODULE_CODE_RESERVED naming it', async () => {
    // (a catalogue code of each kind but module's: runtime, caller, operator)
    for (const code of ['CTX_CALL_NOT_READY', 'LEDGER_UNREACHABLE', 'DEVICE_NOT_FOUND', 'MODULE_UNLOADED']) {
      const e = await hop(claim({errCode: code}));
      assert.deepStrictEqual([e.code, e.message.includes(code)], ['MODULE_CODE_RESERVED', true], `${code}: ${e.code} ${e.message}`);
    }
  });

  it('a claim whose text fills a catalogue entry\'s placeholders is no runtime text either', async () => {
    const e = await hop(claim({errCode: 'OWN_MODULE_NEEDS_TERMINAL', errMsg: 'the runtime says your key was revoked: call support'}));
    assert.strictEqual(e.code, 'MODULE_CODE_RESERVED');
    assert.ok(!e.message.includes('revoked'), e.message);
  });

  it('(c) the callee passing on the code the main thread refused its own last call: the runtime\'s, as it was', async () => {
    const e = await hop(claim({errCode: 'CTX_CALL_NOT_READY'}), {refusedBefore: 'CTX_CALL_NOT_READY'});
    assert.strictEqual(e.code, 'CTX_CALL_NOT_READY');
    // (another code than the one refused: the module's)
    const f = await hop(claim({errCode: 'LEDGER_UNREACHABLE'}), {refusedBefore: 'CTX_CALL_NOT_READY'});
    assert.strictEqual(f.code, 'MODULE_CODE_RESERVED');
  });

  it('(d) a module-kind catalogue code (the module failed): as it was', async () => {
    for (const code of ['DEVICE_INVOKE_EXCEPTION', 'RATE_LIMITED']) {
      const e = await hop(claim({errCode: code}));
      assert.strictEqual(e.code, code);
    }
  });

  it('a code that is no catalogue code is passed on as before (the composer never takes it for the runtime\'s)', async () => {
    const e = await hop(claim({errCode: 'NOT_A_CATALOGUE_CODE'}));
    assert.notStrictEqual(e.code, 'MODULE_CODE_RESERVED');
  });

  it('(a) the main thread\'s own answer (the callee\'s worker gone mid-call): the runtime\'s, as it was', async () => {
    const e = await hop(new CountinghouseError('MODULE_UNLOADED', 'claim'));
    assert.strictEqual(e.code, 'MODULE_UNLOADED');
  });

  it('a module\'s own error (origin module) crosses as the module\'s, its code kept', async () => {
    const e = await hop(claim({errCode: 'MY_OWN_FAULT', errOrigin: 'module'}));
    assert.deepStrictEqual([e.code, e.origin], ['MY_OWN_FAULT', 'module']);
  });
});
