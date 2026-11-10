// The error class of the logger-and-errors spec (docs/superpowers/specs/
// 2026-11-09-logger-design.md §5.1): it renders at construction (the
// catalogue text, then ": " and the arguments), serialises as code and
// message only (no topic since step 1 (d2)), and has a name, a real stack,
// and kind/retryable/httpStatus/mcpCode from the catalogue. No server.
const assert  = require('assert');
const options = require('../../lib/cli-options');
const errors  = require('../../lib/countinghouse-error');

describe('validation 03: CountinghouseError (logger-design §5.1)', () => {
  const {CountinghouseError, CHError, DeviceError} = errors;

  it('renders the catalogue text, then ": " and the arguments, and serialises as code and message only', () => {
    const cases = [
      [['DEVICE_NOT_FOUND'], 'Device not found'],
      [['ARGUMENTS_INVALID', 'x must be a string'], 'Invalid call arguments: x must be a string'],
      [['SYSTEM_ERROR', {a: 1}, 'and more'], 'System error: {"a":1} and more'],
      [['LOAD_MODULE_FAIL', 'm', null, 'reason'], 'Module load failed: m reason'],
      [['NOT_A_CATALOGUE_CODE'], 'NOT_A_CATALOGUE_CODE'],
      [['NOT_A_CATALOGUE_CODE', 'detail'], 'NOT_A_CATALOGUE_CODE']];
    for (const [args, message] of cases) {
      const e = new CountinghouseError(...args);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(e)), {code: args[0], message: message}, JSON.stringify(args));
    }
  });

  it('is a real Error: a name, and a stack that starts where it was thrown', () => {
    const e = new CountinghouseError('DEVICE_NOT_FOUND');
    assert.ok(e instanceof Error);
    assert.ok(e instanceof CountinghouseError);
    assert.strictEqual(e.name, 'CountinghouseError');
    const firstFrame = (err) => String(err.stack).split('\n').find((l) => /^\s+at /.test(l)) || '';
    assert.ok(firstFrame(e).includes('03-error-class.js'), e.stack);
  });

  // Until a later commit of step 1 (d2) retires them, the module-facing
  // globals are the old names, and they must make the same class lib/ makes,
  // or lib/service.js would stop recognising a module's typed error.
  it('the old names (behind the module-facing globals) make CountinghouseErrors, without a topic', () => {
    const fromCH = new CHError('DEVICE_NOT_FOUND', 'd1');
    const fromDevice = new DeviceError('DEVICE_OFFLINE', 'x');
    assert.ok(fromCH instanceof CountinghouseError);
    assert.ok(fromDevice instanceof CountinghouseError);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(fromCH)), {code: 'DEVICE_NOT_FOUND', message: 'Device not found: d1'});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(fromDevice)), {code: 'DEVICE_OFFLINE', message: 'Device is offline: x'});
    const firstFrame = (err) => String(err.stack).split('\n').find((l) => /^\s+at /.test(l)) || '';
    assert.ok(firstFrame(fromDevice).includes('03-error-class.js'), fromDevice.stack);
  });

  // It decides by arguments.length, as the old classes did: an explicit
  // undefined code (CountinghouseError.fromReply may pass `err.code != null ?
  // err.code : err.message`) is kept as undefined, message and all, not
  // turned into null and 'unknown error'.
  it('keeps an explicit undefined code as the old classes did', () => {
    for (const e of [new CountinghouseError(undefined)]) {
      assert.ok(Object.prototype.hasOwnProperty.call(e, 'code'));
      assert.strictEqual(e.code, undefined);
      assert.strictEqual(e.message, undefined);
    }
    const none = new CountinghouseError();
    assert.deepStrictEqual([none.code, none.message], [null, 'unknown error']);
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
      options.locale = 'zh-CN';
      assert.notStrictEqual(new CountinghouseError('DEVICE_NOT_FOUND').message, 'Device not found');
    } finally { options.locale = saved; }
  });
});
