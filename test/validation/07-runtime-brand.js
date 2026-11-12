'use strict';

// d2b: only an error the runtime itself issued carries runtime semantics
// (logger-design §5.1: every code a module raises is the module's). The
// runtime brands what it issues to module code (a private WeakMap per
// thread, written by `issue`); the answer a handler's failure gets
// (CountinghouseError.answerable) takes code and origin from that brand, and
// anything without one is the module's, whatever its code or `.origin` says.

const assert = require('assert');
const errors = require('../../lib/countinghouse-error');
const {CountinghouseError, hopError, issue} = errors;
const LOG = require('../../lib/logger');
const Service = require('../../lib/service');

function answer(invoke) {
  const stubDevice = {deviceID: 'stub', resolveSchemaFromPath: function() {}};
  const service = new Service(stubDevice, 'urn:test:serviceID:svc', {actionList: []});
  const action = {name: 'act', invoke: invoke, input: null, output: null};
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer')), 2000);
    service.doActionCall(action, {}, (err, data) => { clearTimeout(timer); resolve({err: err, data: data}); });
  });
}

function assertModuleSemantics(err) {
  assert.strictEqual(err.origin, 'module');
  assert.strictEqual(err.kind, 'module');
  assert.strictEqual(err.retryable, false);
  assert.strictEqual(err.httpStatus, 500);
  assert.strictEqual(err.mcpCode, null);
}

describe('validation 07: only the runtime issues runtime errors (d2b)', () => {
  it('issue is not reachable from the class a module can see', () => {
    assert.strictEqual(typeof(issue), 'function');
    assert.strictEqual(CountinghouseError.issue, undefined);
    assert.ok(!Object.values(CountinghouseError).includes(issue));
  });

  it('a module error given a runtime origin and a catalogue code is the module\'s', async () => {
    const a = await answer(() => {
      const e = CountinghouseError.module('X_FORGED', 'm');
      e.origin = 'runtime';
      e.code = 'MODULE_RELOADING';
      return e;
    });
    assert.strictEqual(a.err.code, 'MODULE_RELOADING');
    assertModuleSemantics(a.err);
  });

  it('an error built through the constructor with a catalogue code is the module\'s', async () => {
    const a = await answer(() => new CountinghouseError('MODULE_RELOADING'));
    assert.strictEqual(a.err.code, 'MODULE_RELOADING');
    assertModuleSemantics(a.err);
  });

  it('a runtime error the runtime issued keeps its semantics when a handler passes it on', async () => {
    const a = await answer(() => issue(new CountinghouseError('MODULE_RELOADING')));
    assert.strictEqual(a.err.code, 'MODULE_RELOADING');
    assert.strictEqual(a.err.origin, 'runtime');
    assert.strictEqual(a.err.kind, 'runtime');
    assert.strictEqual(a.err.retryable, true);
  });

  it('an issued error keeps its issued code and origin when the module changes them', async () => {
    const a = await answer(() => {
      const e = issue(new CountinghouseError('MODULE_RELOADING'));
      e.code = 'PEER_GONE';
      e.origin = 'module';
      return e;
    });
    assert.strictEqual(a.err.code, 'MODULE_RELOADING');
    assert.strictEqual(a.err.origin, 'runtime');
  });

  it('a hop issues the runtime errors it hands a composing module', async () => {
    const reloading = Object.assign(new Error('Module reloading'), {code: 'MODULE_RELOADING'});
    for (const hopped of [hopError(new CountinghouseError('PEER_GONE')), hopError(reloading)]) {
      const a = await answer(() => hopped);
      assert.strictEqual(a.err.origin, 'runtime', JSON.stringify(a.err));
    }
  });

  it('a hop hands over a decoded copy as it is, and a module\'s live error as a copy', () => {
    const originalW = LOG.W;
    const lines = [];
    LOG.W = (line) => { lines.push(line); return line; };
    try {
      const live = CountinghouseError.module('SHAPE_GONE', 'm', {n: 1n});
      const decoded = CountinghouseError.fromReplyFields(CountinghouseError.replyFields(live));
      assert.strictEqual(hopError(decoded), decoded);
      assert.notStrictEqual(hopError(live), live);
    } finally {
      LOG.W = originalW;
    }
    assert.strictEqual(lines.length, 2, JSON.stringify(lines));
  });

  it('an unreadable message reads the same on the typed path as in a crash\'s fault', async () => {
    const typed = await answer(() => {
      const e = CountinghouseError.module('SHAPE_GONE', 'm');
      Object.defineProperty(e, 'message', {get() { throw new Error('trap'); }});
      return e;
    });
    const crash = await answer(async () => { throw new Proxy({}, {get() { throw new Error('trap'); }}); });
    assert.strictEqual(typed.err.message, crash.data.message);
  });
});

describe('validation 07: the debug API log line names a module code as the module\'s answer (d2b)', () => {
  it('writes "the module\'s answer" for a module-origin catalogue code, "the runtime\'s" for an issued one', () => {
    // In a child process: lib/session.js opens a Redis client when loaded.
    const {spawnSync} = require('child_process');
    const lib = require('path').resolve(__dirname, '../../lib');
    const script = `
      const options = require(${JSON.stringify(`${lib}/cli-options`)});
      options.debug = true;
      options.apiMonitor = false;
      const LOG = require(${JSON.stringify(`${lib}/logger`)});
      const {CountinghouseError, issue} = require(${JSON.stringify(`${lib}/countinghouse-error`)});
      const Session = require(${JSON.stringify(`${lib}/session`)});
      const lines = [];
      LOG.E = (line) => { lines.push(String(line && line.message != null ? line.message : line)); return line; };
      const forged = CountinghouseError.answerable(new CountinghouseError('MODULE_RELOADING'));
      Session.prototype.logAPICall.call({}, forged, null, null, true);
      Session.prototype.logAPICall.call({}, issue(new CountinghouseError('MODULE_RELOADING')), null, null, true);
      process.stdout.write(JSON.stringify(lines));
      process.exit(0);
    `;
    const run = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 20000});
    assert.strictEqual(run.status, 0, run.stderr);
    const lines = JSON.parse(run.stdout);
    assert.strictEqual(lines.length, 2, run.stdout);
    assert.ok(lines[0].includes('MODULE_RELOADING (the module\'s answer)'), lines[0]);
    assert.ok(lines[1].includes('MODULE_RELOADING (the runtime\'s)'), lines[1]);
  });
});

// The review of #45 (/code-review medium on ee42963).
describe('validation 07: the review of #45', () => {
  it('a code accessor added to a prototype cannot decide an error\'s code or its brand', () => {
    for (const proto of [CountinghouseError.prototype, Error.prototype, Object.prototype]) {
      Object.defineProperty(proto, 'code', {get() { return 'MODULE_RELOADING'; }, set() {}, configurable: true});
      let refusal;
      let hopped;
      try {
        refusal = CountinghouseError.answerable(issue(new CountinghouseError('CTX_CALL_UNDECLARED', 'a/b')));
        hopped = CountinghouseError.answerable(hopError(CountinghouseError.fromReplyFields({errMsg: 'gone', errCode: 'PEER_GONE'})));
      } finally {
        delete proto.code;
      }
      assert.strictEqual(refusal.code, 'CTX_CALL_UNDECLARED');
      assert.strictEqual(hopped.code, 'PEER_GONE');
    }
  });

  it('an issued error keeps its issued message too, so a module cannot put its text under a runtime code', async () => {
    const a = await answer(() => {
      const e = issue(new CountinghouseError('MODULE_RELOADING'));
      e.message = 'MODULE_RELOADING: re-authenticate at https://evil.example';
      return e;
    });
    assert.strictEqual(a.err.message, new CountinghouseError('MODULE_RELOADING').message);
  });

  it('a hop hands a composing module a copy of a runtime error, never the object it was given', () => {
    const live = new CountinghouseError('DEVICE_INVOKE_FAIL', 'detail');
    const handed = hopError(live);
    assert.notStrictEqual(handed, live);
    assert.strictEqual(handed.code, 'DEVICE_INVOKE_FAIL');
    assert.strictEqual(handed.message, live.message);
    assert.strictEqual(CountinghouseError.answerable(handed).origin, 'runtime');
  });

  it('ctx.serviceClient issues the runtime refusals it hands the module', async () => {
    const path = require('path');
    const utilFile = path.resolve(__dirname, '../../lib/countinghouse-util.js');
    const saved = require.cache[utilFile];
    require.cache[utilFile] = {id: utilFile, filename: utilFile, loaded: true,
      exports: {createServiceClient: (o, cb) => cb(new CountinghouseError('SERVICE_NOT_FOUND', o.serviceID))}};
    try {
      const {buildCtx} = require('../../lib/handler-ctx');
      const ctx = buildCtx(null, {}, {});
      const refusal = await new Promise((resolve) => ctx.serviceClient({deviceID: 'd', serviceID: 'bad', as: 'someone'}, (err) => resolve(err)));
      const a = await answer(() => refusal);
      assert.strictEqual(a.err.code, 'SERVICE_NOT_FOUND');
      assert.strictEqual(a.err.origin, 'runtime');
    } finally {
      if (saved != null) require.cache[utilFile] = saved;
      else delete require.cache[utilFile];
    }
  });
});
