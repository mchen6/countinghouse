'use strict';

// Service.prototype.doActionCall's failure answers, driven directly: no
// server, no redis. A handler's failure is always answered, whatever the
// value; a crash's answer carries the fault (message, name, stack) as a
// crash always has, each field as text (logger-design §5.1; reviews of
// c10, c11 and c12 on #37).

const assert = require('assert');
const Service = require('../../lib/service');
const {CountinghouseError} = require('../../lib/countinghouse-error');
const LOG = require('../../lib/logger');

function makeService(invoke) {
  const stubDevice = {deviceID: 'stub', resolveSchemaFromPath: function() {}};
  const service = new Service(stubDevice, 'urn:test:serviceID:svc', {actionList: []});
  return {service: service, action: {name: 'act', invoke: invoke, input: null, output: null}};
}

// The answer (err, data) a handler gets, or a failure if none comes.
function answer(invoke) {
  const {service, action} = makeService(invoke);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer')), 2000);
    service.doActionCall(action, {}, (err, data) => {
      clearTimeout(timer);
      resolve({err: err, data: data});
    });
  });
}

describe('validation 06: a handler failure is always answered (Service.doActionCall)', () => {
  it('renders a fault field that cannot be rendered as "[unrenderable value]"', async () => {
    const stack = new Proxy({}, {get() { throw new Error('trap'); }});
    const a = await answer(async () => { throw Object.assign(new Error('x'), {stack: stack}); });
    assert.strictEqual(a.err.code, 'DEVICE_INVOKE_EXCEPTION');
    assert.deepStrictEqual(a.data, {message: 'x', name: 'Error', stack: '[unrenderable value]'});
  });

  it('loses only the field whose getter throws', async () => {
    const a = await answer(async () => {
      const e = new Error('db down');
      Object.defineProperty(e, 'stack', {get() { throw new Error('trap'); }});
      throw e;
    });
    assert.deepStrictEqual(a.data, {message: 'db down', name: 'Error', stack: undefined});
  });

  it('never puts a function\'s source in the message', async () => {
    const fn = function moduleSecretSource() { return 'body of the module'; };
    const a = await answer((args, callback) => callback({message: fn}));
    assert.strictEqual(a.err.code, 'DEVICE_INVOKE_FAIL');
    assert.ok(!a.err.message.includes('body of the module'), a.err.message);
    assert.ok(a.err.message.endsWith(': [function]'), a.err.message);
  });

  it('never runs a message\'s own toString when its JSON is nothing', async () => {
    const message = {toJSON() { return undefined; }, toString() { return 'from toString'; }};
    const a = await answer((args, callback) => callback({message: message}));
    assert.ok(!a.err.message.includes('from toString'), a.err.message);
    assert.ok(a.err.message.endsWith(': [unrenderable value]'), a.err.message);
  });

  it('answers as a crash when building a module\'s error fails (a runtime bug), not never, and logs where', async () => {
    const original = CountinghouseError.module;
    const originalE = LOG.E;
    const lines = [];
    CountinghouseError.module = () => { throw new TypeError('the stub\'s own message'); };
    LOG.E = (line) => { lines.push(line); return line; };
    try {
      const a = await answer((args, callback) => callback(Object.assign(new Error('typed'), {code: 'SHAPE_REJECTED'}), {fault: {kept: 'no'}}));
      assert.strictEqual(a.err.code, 'DEVICE_INVOKE_EXCEPTION');
      assert.strictEqual(a.data.message, 'typed');
      assert.strictEqual(a.data.name, 'Error');
      assert.strictEqual(typeof(a.data.stack), 'string');
      assert.ok(!('kept' in a.data), JSON.stringify(a.data));
      const b = await answer(async () => { throw Object.assign(new Error('typed'), {code: 'SHAPE_REJECTED'}); });
      assert.strictEqual(b.err.code, 'DEVICE_INVOKE_EXCEPTION');
    } finally {
      CountinghouseError.module = original;
      LOG.E = originalE;
    }
    assert.strictEqual(lines.length, 2, JSON.stringify(lines));
    for (const line of lines) {
      assert.strictEqual(typeof(line), 'string');
      assert.ok(line.includes('TypeError'), line);
      assert.ok(/06-fail-answers\.js:\d+/.test(line), `names where it threw: ${line}`);
      assert.ok(!line.includes('the stub\'s own message') && !line.includes('typed'), line);
    }
  });

  it('never logs a runtime bug\'s message, even one that looks like a stack frame, or a thrown string', async () => {
    const original = CountinghouseError.module;
    const originalE = LOG.E;
    const lines = [];
    LOG.E = (line) => { lines.push(line); return line; };
    try {
      CountinghouseError.module = () => { throw new TypeError('module text\n    at secret-token.js:1:1'); };
      await answer((args, callback) => callback(Object.assign(new Error('typed'), {code: 'SHAPE_REJECTED'})));
      CountinghouseError.module = () => { throw 'bad secret-token'; };
      const b = await answer((args, callback) => callback(Object.assign(new Error('typed'), {code: 'SHAPE_REJECTED'})));
      assert.strictEqual(b.err.code, 'DEVICE_INVOKE_EXCEPTION');
    } finally {
      CountinghouseError.module = original;
      LOG.E = originalE;
    }
    assert.strictEqual(lines.length, 2, JSON.stringify(lines));
    for (const line of lines) assert.ok(!line.includes('secret-token') && !line.includes('module text'), line);
    assert.ok(/06-fail-answers\.js:\d+/.test(lines[0]), lines[0]);
  });

  it('reads a failure\'s message once', async () => {
    let reads = 0;
    const thrown = {get message() { reads++; return 'counted'; }};
    const a = await answer(async () => { throw thrown; });
    assert.strictEqual(a.err.code, 'DEVICE_INVOKE_EXCEPTION');
    assert.strictEqual(a.data.message, 'counted');
    assert.strictEqual(reads, 1);
  });
});

// The review of c14: a module owns the error object it hands back and may
// change it afterwards; the answer is the runtime's copy, which always
// crosses a thread reply and is always written as JSON.
describe('validation 06: the review of c14 -- a module\'s own error is answered as the runtime\'s copy', () => {
  // The answer must survive what every edge does to it: a thread reply's
  // structured clone, and JSON.
  function assertAnswerable(err) {
    assert.ok(err.code == null || typeof(err.code) === 'string', `code: ${typeof(err.code)}`);
    assert.strictEqual(typeof(err.message), 'string');
    structuredClone(CountinghouseError.replyFields(err));
    JSON.stringify({code: err.code, message: err.message});
  }

  const changed = {
    'a function code': (e) => { e.code = () => 1; },
    'a Symbol code': (e) => { e.code = Symbol('s'); },
    'an object code': (e) => { e.code = {a: 1}; },
    'a code getter that throws': (e) => { Object.defineProperty(e, 'code', {get() { throw new Error('trap'); }}); },
    'a message whose toString throws': (e) => { e.message = {toString() { throw new Error('trap'); }, toJSON() { throw new Error('trap'); }}; },
    'a message getter that throws': (e) => { Object.defineProperty(e, 'message', {get() { throw new Error('trap'); }}); }
  };
  for (const [what, change] of Object.entries(changed)) {
    it(`answers a returned module error given ${what} afterwards`, async () => {
      const a = await answer(() => { const e = CountinghouseError.module('SHAPE_REJECTED', 'm'); change(e); return e; });
      assertAnswerable(a.err);
    });
  }

  it('answers an error built through the constructor with a function code', async () => {
    const a = await answer(() => new CountinghouseError(() => 1));
    assertAnswerable(a.err);
  });

  it('is not the module\'s object, so a later change never reaches the answer', async () => {
    let kept;
    const a = await answer(() => { kept = CountinghouseError.module('SHAPE_REJECTED', 'm', {n: 1}); return kept; });
    assert.notStrictEqual(a.err, kept);
    assert.strictEqual(a.err.code, 'SHAPE_REJECTED');
    assert.strictEqual(a.err.message, 'SHAPE_REJECTED: m');
    assert.strictEqual(a.err.origin, 'module');
    assert.deepStrictEqual(CountinghouseError.replyFields(a.err).errDetails, {n: 1});
    kept.code = () => 1;
    assertAnswerable(a.err);
  });

  it('replyFields never throws and is always cloneable, whatever the error holds', () => {
    for (const change of Object.values(changed)) {
      const e = CountinghouseError.module('SHAPE_REJECTED', 'm');
      change(e);
      structuredClone(CountinghouseError.replyFields(e));
    }
  });

  it('names an object code in no log line', () => {
    const originalW = LOG.W;
    const lines = [];
    LOG.W = (line) => { lines.push(line); return line; };
    try {
      CountinghouseError.replyFields(CountinghouseError.module({apiKey: 'sk-secret'}, 'm', {n: 1n}));
      CountinghouseError.replyFields(CountinghouseError.module('SHAPE_REJECTED', 'm', {n: 1n}));
    } finally {
      LOG.W = originalW;
    }
    assert.strictEqual(lines.length, 2, JSON.stringify(lines));
    assert.ok(!lines[0].includes('sk-secret') && !lines[0].includes('apiKey'), lines[0]);
    assert.ok(lines[1].includes('SHAPE_REJECTED'), lines[1]);
  });

  it('logs no line of a runtime bug\'s message, even after the message was changed, and no name of its own', async () => {
    const original = CountinghouseError.module;
    const originalE = LOG.E;
    const lines = [];
    LOG.E = (line) => { lines.push(line); return line; };
    try {
      CountinghouseError.module = () => {
        const e = new TypeError('module text\n    at /secret-token.js:1:1');
        void e.stack;
        e.message = '';
        throw e;
      };
      await answer((args, callback) => callback(Object.assign(new Error('typed'), {code: 'SHAPE_REJECTED'})));
      CountinghouseError.module = () => { throw Object.assign(new TypeError('x'), {name: 'sk_live_name'}); };
      await answer((args, callback) => callback(Object.assign(new Error('typed'), {code: 'SHAPE_REJECTED'})));
    } finally {
      CountinghouseError.module = original;
      LOG.E = originalE;
    }
    assert.strictEqual(lines.length, 2, JSON.stringify(lines));
    for (const line of lines) {
      assert.ok(!line.includes('secret-token') && !line.includes('module text') && !line.includes('sk_live_name'), line);
      assert.ok(/06-fail-answers\.js:\d+/.test(line), `names where it threw: ${line}`);
    }
  });
});

// The review of c15: what a handler returns, and what it reports with its
// failure, is read guarded too; a reply that cannot be cloned is still a
// reply; no log line names a file outside the runtime or the caller's input.
describe('validation 06: the review of c15 -- every failure is answered, and logged without module or caller data', () => {
  const trapPrototype = () => new Proxy({}, {getPrototypeOf() { throw new Error('trap'); }});

  it('answers a returned value whose prototype trap throws', async () => {
    const a = await answer(() => trapPrototype());
    assert.strictEqual(a.err.code, 'DEVICE_INVOKE_EXCEPTION');
  });

  it('answers a returned value whose then getter throws', async () => {
    const a = await answer(() => ({get then() { throw new Error('trap'); }}));
    assert.strictEqual(a.err.code, 'DEVICE_INVOKE_EXCEPTION');
  });

  it('answers a promise that resolves to a value whose prototype trap throws', async () => {
    const a = await answer(async () => trapPrototype());
    assert.strictEqual(a.err.code, 'DEVICE_INVOKE_EXCEPTION');
  });

  it('answers a failure whose output\'s fault getter throws', async () => {
    const output = new Proxy({}, {get() { throw new Error('trap'); }});
    const a = await answer((args, callback) => callback(CountinghouseError.module('SHAPE_REJECTED', 'm'), output));
    assert.strictEqual(a.err.code, 'SHAPE_REJECTED');
  });

  it('a worker reply whose data cannot be cloned is answered as a crash', async () => {
    const {Worker} = require('worker_threads');
    const lib = require('path').resolve(__dirname, '../../lib/worker-message.js');
    const worker = new Worker(`
      const WorkerMessage = require(${JSON.stringify(lib)});
      WorkerMessage.prototype.sendMessageToParent.call({}, 7, null, {f() {}});
    `, {eval: true});
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reply')), 5000);
      worker.once('message', (m) => { clearTimeout(timer); resolve(m); });
      worker.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    await worker.terminate();
    assert.strictEqual(msg.id, 7);
    assert.strictEqual(msg.errCode, 'DEVICE_INVOKE_EXCEPTION');
    assert.ok(msg.errMsg != null);
  });

  it('logs no file outside the runtime\'s root for a runtime bug', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch06-alice-'));
    const file = path.join(dir, 'alice-thrower.js');
    fs.writeFileSync(file, 'module.exports = function() { throw new TypeError(\'x\'); };\n');
    const thrower = require(file);
    const original = CountinghouseError.module;
    const originalE = LOG.E;
    const lines = [];
    LOG.E = (line) => { lines.push(line); return line; };
    try {
      CountinghouseError.module = () => thrower();
      await answer((args, callback) => callback(Object.assign(new Error('typed'), {code: 'SHAPE_REJECTED'})));
    } finally {
      CountinghouseError.module = original;
      LOG.E = originalE;
      delete require.cache[file];
      fs.rmSync(dir, {recursive: true, force: true});
    }
    assert.strictEqual(lines.length, 1, JSON.stringify(lines));
    assert.ok(!lines[0].includes('alice') && !lines[0].includes(os.tmpdir()), lines[0]);
    assert.ok(/06-fail-answers\.js:\d+/.test(lines[0]), `names the runtime's own frame: ${lines[0]}`);
  });

  it('the debug API log line carries neither the caller\'s input nor the module\'s message or fault', () => {
    // In a child process: lib/session.js opens a Redis client when it is
    // loaded, which would keep this folder's process alive.
    const {spawnSync} = require('child_process');
    const lib = require('path').resolve(__dirname, '../../lib');
    const script = `
      const options = require(${JSON.stringify(`${lib}/cli-options`)});
      options.debug = true;
      options.apiMonitor = false;
      const LOG = require(${JSON.stringify(`${lib}/logger`)});
      const {CountinghouseError} = require(${JSON.stringify(`${lib}/countinghouse-error`)});
      const Session = require(${JSON.stringify(`${lib}/session`)});
      const lines = [];
      LOG.E = (line) => { lines.push(String(line && line.message != null ? line.message : line)); return line; };
      const err = CountinghouseError.module('UPSTREAM_FAIL', 'token sk-module-secret rejected');
      Session.prototype.logAPICall.call({}, err, {input: {apiKey: 'sk-caller-secret'}}, {fault: 'f-secret'}, true);
      Session.prototype.logAPICall.call({}, err, null, {fault: 'f-secret'}, true);
      process.stdout.write(JSON.stringify(lines));
      process.exit(0);
    `;
    const run = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 20000});
    assert.strictEqual(run.status, 0, run.stderr);
    const lines = JSON.parse(run.stdout);
    assert.strictEqual(lines.length, 2, run.stdout);
    for (const line of lines) {
      assert.ok(!/sk-module-secret|sk-caller-secret|f-secret/.test(line), line);
      assert.ok(line.includes('UPSTREAM_FAIL'), line);
    }
  });
});
