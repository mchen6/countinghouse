'use strict';

// Service.prototype.doActionCall's failure answers, driven directly: no
// server, no redis. A handler's failure is always answered, whatever the
// value, and the answer never carries more of the module than its message
// (logger-design §5.1; reviews of c10 and c11 on #37).

const assert = require('assert');
const Service = require('../../lib/service');
const {CountinghouseError} = require('../../lib/countinghouse-error');

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

  it('answers as a crash when building a module\'s error fails (a runtime bug), not never', async () => {
    const original = CountinghouseError.module;
    CountinghouseError.module = () => { throw new Error('a runtime bug'); };
    try {
      const a = await answer((args, callback) => callback(Object.assign(new Error('typed'), {code: 'SHAPE_REJECTED'})));
      assert.strictEqual(a.err.code, 'DEVICE_INVOKE_EXCEPTION');
      const b = await answer(async () => { throw Object.assign(new Error('typed'), {code: 'SHAPE_REJECTED'}); });
      assert.strictEqual(b.err.code, 'DEVICE_INVOKE_EXCEPTION');
    } finally {
      CountinghouseError.module = original;
    }
  });
});
