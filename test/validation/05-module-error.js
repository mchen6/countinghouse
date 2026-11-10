// A module's error (logger-design §5.1, step 1 (d1)): what ctx.error returns.
// It has origin 'module', and the catalogue says nothing about it: kind
// 'module', status 500, mcpCode null, not retryable, even when its code is
// a catalogue name (a module's codes are its own). It renders "CODE: message"
// (the bare code with no message): a module code has no catalogue text, and
// rendering it as the old classes did would drop the module's message. No
// server.
const assert = require('assert');
const {CountinghouseError} = require('../../lib/countinghouse-error');

describe('validation 05: a module\'s error (ctx.error, logger-design §5.1)', () => {
  it('has origin module, kind module and the module defaults, whatever the code', () => {
    for (const code of ['REPO_TOO_LARGE', 'DEVICE_OFFLINE', 'ADMIN_REQUIRED']) {
      const e = CountinghouseError.module(code, 'why');
      assert.ok(e instanceof CountinghouseError);
      assert.deepStrictEqual([e.origin, e.kind, e.retryable, e.httpStatus, e.mcpCode], ['module', 'module', false, 500, null], code);
    }
  });

  it('renders CODE: message, or the bare code with no message', () => {
    assert.strictEqual(CountinghouseError.module('REPO_TOO_LARGE', 'over 2 GB').message, 'REPO_TOO_LARGE: over 2 GB');
    assert.strictEqual(CountinghouseError.module('REPO_TOO_LARGE').message, 'REPO_TOO_LARGE');
    assert.strictEqual(CountinghouseError.module('DEVICE_OFFLINE', 'mine').message, 'DEVICE_OFFLINE: mine');
  });

  it('serialises as a module error does today (topic device error, code, message), details not enumerable', () => {
    const e = CountinghouseError.module('REPO_TOO_LARGE', 'over 2 GB', {limit: 2});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(e)), {topic: 'device error', code: 'REPO_TOO_LARGE', message: 'REPO_TOO_LARGE: over 2 GB'});
    assert.deepStrictEqual(e.details, {limit: 2});
    assert.deepStrictEqual(CountinghouseError.module('X_Y').details, {});
  });

  it('has a stack from where the module made it', () => {
    const e = CountinghouseError.module('REPO_TOO_LARGE');
    const first = String(e.stack).split('\n').find((l) => /^\s+at /.test(l)) || '';
    assert.ok(first.includes('05-module-error.js'), e.stack);
  });

  it('never throws, whatever it is given', () => {
    for (const args of [[], [null], [42, {}], ['', undefined, null]]) {
      assert.ok(CountinghouseError.module(...args) instanceof CountinghouseError, JSON.stringify(args));
    }
  });

  it('leaves a runtime error\'s catalogue fields alone', () => {
    const r = new CountinghouseError('ADMIN_REQUIRED');
    assert.deepStrictEqual([r.origin, r.kind, r.httpStatus], ['runtime', 'caller', 403]);
  });
});
