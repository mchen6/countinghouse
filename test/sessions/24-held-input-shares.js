'use strict';
// Shared runtime B3, Task 7: a hop's held input is shared out per session.
// On master (after #294) each caller worker has its own share of the held
// announcement bytes, its own share of their count, and its own release
// hold-offs; on a shared runtime one worker serves every session, so one
// session's unmatched announcements could refuse another's hops. In shared
// mode all three are the announcing token's session's, across caller
// workers; an entry with no session keeps its worker's. A session's byte
// share follows its own cap, and the total follows the largest active cap
// (lib/session-settings.js largest, kept on every change, never a scan at an
// announcement). The floors are the broker's options, so this file holds
// kilobytes. (The plan names this file 19; 19 to 23 are taken.)
const assert = require('assert');
const EventEmitter = require('events');
const options = require('../../lib/cli-options');
options.setOptions({redisUrl: 'redis://127.0.0.1:1'});
require('../../lib/logger').createLogger();
const callTokens = require('../../lib/call-tokens');
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const sessionPacks = require('../../lib/session-packs');
const PeerChannelBroker = require('../../lib/peer-channel-broker');

describe('sessions 24: a hop\'s held input is shared out per session (shared runtime B3, Task 7)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const CAP = 256;                   // the default --maxOutputBytes here
  const FLOORS = {shareFloorBytes: 1024, totalFloorBytes: 4096, countShare: 4};
  let saved;
  let issued;
  let refused;
  let callee;
  let broker;
  let workers;
  let nextId;
  const bytes = (n) => new ArrayBuffer(n);
  const DECLARED = new Set(['d-callee|svc|act']);
  const worker = (id) => ({workerId: id, bindings: {'d-caller': {identity: null, module: 'caller', targets: DECLARED}},
    sendPeerAnnounceRefusedToChild: (m) => refused.push(Object.assign({worker: id}, m))});
  const tokenOf = (session, workerId, limits = null) => {
    const t = callTokens.issue({billingKey: 'k', identityKey: 'id-k', workerId: workerId, deviceID: 'd-caller', session: session, limits: limits});
    issued.push(t);
    return t;
  };
  // an announcement of n bytes from worker w, under session s's call; -> true when held
  const announce = (s, w, n, limits = null) => {
    const before = refused.length;
    const channel = `${w}:${callee.workerId}`;
    broker.handleAnnouncement({channel, invokeId: nextId++, token: tokenOf(s, w, limits), deviceID: 'd-callee', serviceID: 'svc', actionName: 'act', epoch: 'e', inputBytes: bytes(n)}, workers[w]);
    return refused.length === before;
  };
  const lastCode = () => (refused.length > 0 ? refused[refused.length - 1].errCode : null);
  const openSessions = () => {
    const reg = new EventEmitter();
    sessions.attach(reg);
    for (const id of [A, B]) { const s = new EventEmitter(); s.id = id; s.client = {status: 'ok', conditions: 'yes', repo: null}; s.notify = () => {}; reg.emit('session', s); }
  };

  beforeEach(() => {
    saved = {maxOutputBytes: options.maxOutputBytes, debug: options.debug};
    options.maxOutputBytes = CAP;
    issued = [];
    refused = [];
    nextId = 0;
    sessions.resetForTests();
    settings.resetForTests();
    sessionPacks.resetForTests();
    settings.configure({ceiling: () => ({state: 'none'}), defaultOf: () => options.maxOutputBytes, boundsOf: () => ({min: 1, max: 2 ** 31 - 1})});
    callee = {workerId: 90};
    workers = {1: worker(1), 2: worker(2)};
    broker = new PeerChannelBroker({deviceMap: {'d-callee': callee}}, FLOORS);
    for (const w of [1, 2]) broker.channelRegistry[`${w}:90`] = {callerWM: workers[w], calleeWM: callee, grants: {}};
    openSessions();
  });
  afterEach(() => {
    Object.assign(options, saved);
    for (const t of issued.splice(0)) callTokens.drop(t);
    sessions.resetForTests();
    settings.resetForTests();
    sessionPacks.resetForTests();
  });

  it('A fills its byte share from worker 1: A\'s next is RATE_LIMITED, and B\'s from the same worker is held', () => {
    for (let i = 0; i < 4; i++) assert.ok(announce(A, 1, CAP), `A's ${i}: ${JSON.stringify(refused)}`);   // 4 x 256 = the 1024 floor
    assert.strictEqual(announce(A, 1, 1), false);
    assert.strictEqual(lastCode(), 'RATE_LIMITED');
    assert.ok(announce(B, 1, CAP), JSON.stringify(refused));
  });

  it('A reaches its count share from worker 1 with small inputs: A\'s next is refused, B\'s from worker 1 held', () => {
    for (let i = 0; i < 4; i++) assert.ok(announce(A, 1, 1));
    assert.strictEqual(announce(A, 1, 1), false);
    assert.ok(announce(B, 1, 1));
  });

  it('A\'s announcements from two caller workers count against one share, bytes and count', () => {
    assert.ok(announce(A, 1, 1));
    assert.ok(announce(A, 2, 1));
    assert.ok(announce(A, 1, 1));
    assert.ok(announce(A, 2, 1));
    assert.strictEqual(announce(A, 2, 1), false, 'the count is A\'s, across workers');
  });

  it('a session\'s byte share follows its own cap: A at four times B\'s holds two at its cap; B holds its floor\'s worth and is refused past it', () => {
    settings.set(A, 'maxOutputBytes', 4 * 1024, {loosening: true, over: CAP});
    const limitsA = settings.limitsOf(A);
    assert.ok(announce(A, 1, 4 * 1024, limitsA), JSON.stringify(refused));
    assert.ok(announce(A, 1, 4 * 1024, limitsA), JSON.stringify(refused));
    assert.strictEqual(announce(A, 1, 1, limitsA), false, 'A\'s share: 2 x 4 KiB');
    // B: the 1024 floor at its default cap
    for (let i = 0; i < 4; i++) assert.ok(announce(B, 1, CAP));
    assert.strictEqual(announce(B, 1, CAP), false);
  });

  it('the total follows the largest active cap, kept on every change and never scanned at an announcement', () => {
    const scans = settings.largestScansForTests();
    assert.strictEqual(settings.largest('maxOutputBytes'), null);
    settings.set(A, 'maxOutputBytes', 2048, {loosening: true, over: CAP});
    assert.strictEqual(settings.largest('maxOutputBytes'), 2048, 'set');
    settings.set(B, 'maxOutputBytes', 1024, {loosening: true, over: CAP});
    settings.clear(B, 'maxOutputBytes');
    assert.strictEqual(settings.largest('maxOutputBytes'), 2048, 'clear');
    // the total is max(4096, 8 x 2048) = 16 KiB: A's and B's shares fit under it
    const limitsA = settings.limitsOf(A);
    for (let i = 0; i < 2; i++) assert.ok(announce(A, 1, 2048, limitsA), JSON.stringify(refused));
    const during = settings.largestScansForTests();
    for (let i = 0; i < 4; i++) assert.ok(announce(B, 2, CAP), JSON.stringify(refused));
    assert.strictEqual(settings.largestScansForTests(), during, 'no scan at an announcement');
    // A's override dropped: the total is the floor (4096) again, which the 5 KiB held now exceeds
    settings.dropLooser('maxOutputBytes', CAP);
    assert.strictEqual(settings.largest('maxOutputBytes'), null, 'dropLooser');
    assert.strictEqual(announce(B, 1, 1), false);
    assert.strictEqual(lastCode(), 'RATE_LIMITED');
    settings.set(A, 'maxOutputBytes', 2048, {loosening: true, over: CAP});
    settings.ceilingSeen({state: 'trusted', ceiling: {maxOutputBytes: 512}});
    assert.strictEqual(settings.largest('maxOutputBytes'), 512, 'ceilingSeen');
    settings.forget(A);
    assert.strictEqual(settings.largest('maxOutputBytes'), null, 'forget');
    assert.ok(settings.largestScansForTests() > scans);
  });

  it('an ended call\'s bytes and count leave its session\'s share at the next refusal; A\'s hold-off doesn\'t delay B\'s release', () => {
    for (let i = 0; i < 4; i++) assert.ok(announce(A, 1, 1));
    for (const t of issued) callTokens.drop(t);   // A's calls end
    assert.ok(announce(A, 1, 1), 'released at the refusal, then held');
    // A at its count with live hops: its walk releases nothing, and holds it off
    for (let i = 0; i < 3; i++) assert.ok(announce(A, 1, 1));
    assert.strictEqual(announce(A, 1, 1), false);
    // B's own, ended, still released at once
    for (let i = 0; i < 4; i++) assert.ok(announce(B, 1, 1));
    for (const t of issued.slice(-4)) callTokens.drop(t);
    assert.ok(announce(B, 1, 1), 'B\'s release isn\'t held off by A\'s');
  });

  // #341 review, 7: a full total's walk of every share releases every session's ended hops, so it is bounded
  // per caller worker, as on master: N sessions on one worker don't buy N walks a window
  it('the walk of every share, at a full total, is at most once a window per caller worker, whatever the sessions', () => {
    broker = new PeerChannelBroker({deviceMap: {'d-callee': callee}}, {shareFloorBytes: 1024, totalFloorBytes: 1024, countShare: 64});
    for (const w of [1, 2]) broker.channelRegistry[`${w}:90`] = {callerWM: workers[w], calleeWM: callee, grants: {}};
    broker.monotonicMs = () => 5000;
    let walks = 0;
    const releaseEnded = broker.releaseEnded.bind(broker);
    broker.releaseEnded = (share) => { if (share == null) walks += 1; return releaseEnded(share); };
    // the total is 2048 (8 x the 256 cap): A's share and B's, both full, fill it
    for (let i = 0; i < 4; i++) assert.ok(announce(A, 1, CAP));
    for (let i = 0; i < 4; i++) assert.ok(announce(B, 1, CAP));
    assert.strictEqual(announce(A, 1, 1), false);
    assert.strictEqual(announce(B, 1, 1), false);
    assert.strictEqual(walks, 1, 'one walk for worker 1 in the window, not one per session');
  });

  it('outside shared mode the shares are the caller worker\'s, as on master', () => {
    sessions.resetForTests();
    for (let i = 0; i < 4; i++) assert.ok(announce(null, 1, CAP));
    assert.strictEqual(announce(null, 1, 1), false, 'worker 1\'s 1024 share');
    assert.ok(announce(null, 2, CAP), 'worker 2\'s own');
    assert.ok(announce(null, 2, CAP));
    assert.ok(announce(null, 2, CAP));
    assert.ok(announce(null, 2, CAP));
    // the total: 4096, eight 256-byte hops held, so worker 2's fifth is its own share's refusal
    assert.strictEqual(announce(null, 2, 1), false);
  });
});
