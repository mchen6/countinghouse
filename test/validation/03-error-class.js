// The error class of the logger-and-errors spec (docs/superpowers/specs/
// 2026-11-09-logger-design.md §5.1), step 1 (a): CountinghouseError beside
// the old classes, rendering at construction exactly as they do (byte-
// identity for the codemod that follows), with a name, a real stack, and
// kind/retryable/httpStatus/mcpCode from the catalogue. No server.
const assert  = require('assert');
const options = require('../../lib/cli-options');
const errors  = require('../../lib/countinghouse-error');

describe('validation 03: CountinghouseError (logger-design §5.1)', () => {
  const {CountinghouseError, CHError, DeviceError} = errors;

  it('renders, codes and topics exactly as CHError does, for the same arguments', () => {
    const cases = [['DEVICE_NOT_FOUND'], ['ARGUMENTS_INVALID', 'x must be a string'], ['SYSTEM_ERROR', {a: 1}, 'and more'],
      ['LOAD_MODULE_FAIL', 'm', null, 'reason'], ['NOT_A_CATALOGUE_CODE'], ['NOT_A_CATALOGUE_CODE', 'detail']];
    for (const args of cases) {
      const now = new CountinghouseError(...args);
      const old = new CHError(...args);
      assert.strictEqual(now.message, old.message, JSON.stringify(args));
      assert.strictEqual(now.code, old.code, JSON.stringify(args));
      assert.strictEqual(now.topic, old.topic, JSON.stringify(args));
    }
  });

  it('CountinghouseError.device() renders and keeps the topic exactly as DeviceError does', () => {
    const now = CountinghouseError.device('DEVICE_INVOKE_FAIL', 'boom');
    const old = new DeviceError('DEVICE_INVOKE_FAIL', 'boom');
    assert.deepStrictEqual({message: now.message, code: now.code, topic: now.topic}, {message: old.message, code: old.code, topic: old.topic});
    assert.strictEqual(now.topic, 'device error');
  });

  it('is a real Error: a name, and a stack that starts where it was thrown', () => {
    const e = new CountinghouseError('DEVICE_NOT_FOUND');
    assert.ok(e instanceof Error);
    assert.ok(e instanceof CountinghouseError);
    assert.strictEqual(e.name, 'CountinghouseError');
    const firstFrame = (err) => String(err.stack).split('\n').find((l) => /^\s+at /.test(l)) || '';
    assert.ok(firstFrame(e).includes('03-error-class.js'), e.stack);
    // premise: the old class's stack is its prototype's, taken when lib/ loaded
    assert.ok(firstFrame(new CHError('DEVICE_NOT_FOUND')).includes('countinghouse-error.js'), new CHError('DEVICE_NOT_FOUND').stack);
  });

  it('takes kind, retryable, httpStatus and mcpCode from the catalogue', () => {
    const admin = new CountinghouseError('ADMIN_REQUIRED');
    assert.deepStrictEqual([admin.kind, admin.retryable, admin.httpStatus, admin.mcpCode], ['caller', false, 403, null]);
    const limited = new CountinghouseError('RATE_LIMIT_EXCEEDED');
    assert.deepStrictEqual([limited.kind, limited.retryable, limited.httpStatus], ['caller', true, 429]);
    const restarting = new CountinghouseError('MODULE_RESTARTING');
    assert.deepStrictEqual([restarting.kind, restarting.retryable, restarting.httpStatus], ['runtime', true, 500]);
  });

  it('gives a code the catalogue does not know kind module, status 500, mcpCode null, and its code as its message', () => {
    const e = new CountinghouseError('MY_MODULE_SPECIFIC_CODE');
    assert.deepStrictEqual([e.kind, e.retryable, e.httpStatus, e.mcpCode, e.message], ['module', false, 500, null, 'MY_MODULE_SPECIFIC_CODE']);
  });

  it('create(code, {message, details, cause}) carries them, with the catalogue text when no message is given', () => {
    const cause = new Error('under');
    const e = CountinghouseError.create('DEVICE_NOT_FOUND', {details: {deviceID: 'd1'}, cause: cause});
    assert.deepStrictEqual(e.details, {deviceID: 'd1'});
    assert.strictEqual(e.cause, cause);
    assert.strictEqual(e.message, 'Device not found');
    assert.strictEqual(CountinghouseError.create('DEVICE_NOT_FOUND', {message: 'no such device'}).message, 'no such device');
    assert.strictEqual(e.origin, 'runtime');
  });

  it('falls back to en-US, not zh-CN, when the locale has no catalogue text', () => {
    const saved = options.locale;
    try {
      options.locale = 'xx-XX';
      assert.strictEqual(new CountinghouseError('DEVICE_NOT_FOUND').message, 'Device not found');
      assert.strictEqual(new CHError('DEVICE_NOT_FOUND').message, 'Device not found');
      options.locale = 'zh-CN';
      assert.notStrictEqual(new CountinghouseError('DEVICE_NOT_FOUND').message, 'Device not found');
    } finally { options.locale = saved; }
  });
});
