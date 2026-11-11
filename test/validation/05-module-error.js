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

  it('serialises as code and message only (no topic, step 1 (d2)), details not enumerable', () => {
    const e = CountinghouseError.module('REPO_TOO_LARGE', 'over 2 GB', {limit: 2});
    assert.deepStrictEqual(JSON.parse(JSON.stringify(e)), {code: 'REPO_TOO_LARGE', message: 'REPO_TOO_LARGE: over 2 GB'});
    assert.deepStrictEqual(e.details, {limit: 2});
    assert.deepStrictEqual(CountinghouseError.module('X_Y').details, {});
  });

  // details.cause is reserved for the underlying error (§5.1): it is the
  // error's cause, kept off details and every serialised form.
  it('lifts details.cause into a non-enumerable cause, off details and JSON', () => {
    const inner = Object.assign(new Error('inner text'), {code: 'INNER', secretish: 'inner field'});
    const e = CountinghouseError.module('INNER_CALL_FAILED', 'hop failed', {cause: inner, hop: 2});
    assert.strictEqual(e.cause, inner);
    assert.strictEqual(Object.getOwnPropertyDescriptor(e, 'cause').enumerable, false);
    assert.deepStrictEqual(e.details, {hop: 2});
    const json = JSON.stringify(e);
    assert.deepStrictEqual(JSON.parse(json), {code: 'INNER_CALL_FAILED', message: 'INNER_CALL_FAILED: hop failed'});
    assert.ok(!json.includes('inner'), json);
    const only = CountinghouseError.module('INNER_CALL_FAILED', 'x', {cause: inner});
    assert.deepStrictEqual([only.details, only.cause], [{}, inner]);
  });

  it('leaves the module\'s details object itself alone when it lifts the cause', () => {
    const inner = new Error('inner');
    const given = {cause: inner, hop: 2};
    CountinghouseError.module('INNER_CALL_FAILED', 'x', given);
    assert.deepStrictEqual(given, {cause: inner, hop: 2});
  });

  // Step 1 (d2): every reply between threads (a worker's to the main thread,
  // the main thread's to a composing worker, a peer channel's) carries a
  // module's error whole (code, message, details) as envelope fields, and the
  // other end rebuilds it. The details cross as JSON, the cause not at all.
  it('crosses the reply envelope whole, details as JSON and no cause', () => {
    const inner = Object.assign(new Error('inner text'), {code: 'INNER'});
    const e = CountinghouseError.module('INNER_CALL_FAILED', 'hop failed', {cause: inner, hop: 2, nested: new Error('nested'), fn() {}});
    const envelope = structuredClone(CountinghouseError.replyFields(e));
    assert.ok(!JSON.stringify(envelope).includes('inner text'), JSON.stringify(envelope));
    const back = CountinghouseError.fromReplyFields(envelope);
    assert.ok(back instanceof CountinghouseError);
    assert.deepStrictEqual([back.code, back.message, back.origin, back.kind], ['INNER_CALL_FAILED', 'INNER_CALL_FAILED: hop failed', 'module', 'module']);
    assert.deepStrictEqual(back.details, {hop: 2, nested: {}});
    assert.strictEqual(back.cause, undefined);
    const bare = CountinghouseError.fromReplyFields(structuredClone(CountinghouseError.replyFields(CountinghouseError.module('MINE'))));
    assert.deepStrictEqual([bare.code, bare.message, bare.details], ['MINE', 'MINE', {}]);
    const runtime = CountinghouseError.fromReplyFields({errMsg: 'Device is offline', errCode: 'DEVICE_OFFLINE'});
    assert.ok(!(runtime instanceof CountinghouseError) && runtime.code === 'DEVICE_OFFLINE');
  });

  // A receiver reads a null errMsg as success, so an error always gives one:
  // a message-less error, a thrown string, a runtime error with its code.
  it('always gives an error a non-null errMsg on the envelope', () => {
    const cases = [[new Error(), ''], ['boom', 'boom'], [{code: 'X_Y'}, '[object Object]'], [new CountinghouseError('DEVICE_OFFLINE'), null]];
    for (const [err, text] of cases) {
      const f = CountinghouseError.replyFields(err);
      assert.ok(typeof(f.errMsg) === 'string', JSON.stringify(f));
      if (text != null) assert.strictEqual(f.errMsg, text);
      assert.notStrictEqual(CountinghouseError.fromReplyFields(f), null);
    }
    assert.deepStrictEqual(CountinghouseError.replyFields(new CountinghouseError('DEVICE_OFFLINE')).errCode, 'DEVICE_OFFLINE');
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

  // Step 1 (d2): the old classes and the topic are gone.
  it('is the only error class: no CHError or DeviceError, no device form, and no topic', () => {
    const exported = require('../../lib/countinghouse-error');
    assert.deepStrictEqual(['CHError', 'DeviceError'].filter((n) => n in exported), []);
    assert.strictEqual(CountinghouseError.device, undefined);
    assert.strictEqual('topic' in new CountinghouseError('DEVICE_NOT_FOUND'), false);
    assert.strictEqual('topic' in CountinghouseError.module('X_Y'), false);
  });

  // §5.1's plain-Error rule (step 1 (d2)): a plain Error's .code is the
  // module's own when it looks like a code (/^[A-Z][A-Z0-9_]{2,}$/) and is
  // neither a system error's (errno or syscall) nor Node's (ERR_), nor, as
  // amended (the reviewer, 2026-11-10), a network or TLS library's: an errno
  // name with no errno, undici's UND_ERR_, llhttp's HPE_, and the exact X509
  // verify codes Node gives a TLS error. The list is
  // CountinghouseError.isForeignCode, which countinghouse-validate will read
  // too (step 1 (e)).
  describe('fromModule: a plain Error with a code', () => {
    const plain = (code, extra) => Object.assign(new Error('why'), {code: code}, extra || {});
    it('is the module\'s error when its code looks like one', () => {
      for (const code of ['REPO_TOO_LARGE', 'ABC', 'X2_Y', 'DEVICE_OFFLINE']) {
        const e = CountinghouseError.fromModule(plain(code));
        assert.ok(e instanceof CountinghouseError, code);
        assert.deepStrictEqual([e.code, e.message, e.origin, e.kind], [code, `${code}: why`, 'module', 'module'], code);
      }
    });
    it('is not, for a system error, a Node error, or a code that does not look like one', () => {
      const cases = [plain('EACCES', {errno: -13}), plain('ENOENT', {syscall: 'open'}), plain('ERR_INVALID_ARG_TYPE'),
        plain('ERR_OUT_OF_RANGE'), plain('MODULE_NOT_FOUND'), plain('ABORT_ERR'), plain('AB'), plain('lower_case'), plain('1ABC'), plain('A-B-C'), plain(42), new Error('no code'), null, undefined, 'a string'];
      for (const c of cases) assert.strictEqual(CountinghouseError.fromModule(c), null, JSON.stringify(c && c.code));
    });
    const FOREIGN = ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
      'HPE_INVALID_CONSTANT', 'HPE_INVALID_HEADER_TOKEN',
      'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'HOSTNAME_MISMATCH', 'INVALID_CA', 'CRL_HAS_EXPIRED',
      'ERROR_IN_CERT_NOT_AFTER_FIELD', 'OUT_OF_MEM', 'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'CERT_REVOKED'];
    it('is not, for a network, HTTP-parser or TLS code with no errno (an errno name, UND_ERR_, HPE_, X509 verify codes)', () => {
      for (const code of FOREIGN) assert.strictEqual(CountinghouseError.fromModule(plain(code)), null, code);
    });
    it('reads its list from one exported place, CountinghouseError.isForeignCode', () => {
      assert.strictEqual(typeof(CountinghouseError.isForeignCode), 'function');
      for (const code of FOREIGN.concat(['ERR_INVALID_ARG_TYPE', 'MODULE_NOT_FOUND', 'ABORT_ERR'])) {
        assert.strictEqual(CountinghouseError.isForeignCode(code), true, code);
      }
      for (const code of ['REPO_TOO_LARGE', 'ABC', 'X2_Y', 'DEVICE_OFFLINE', 'CERTIFIED_ONLY', 'SELF_TEST_FAILED',
        'UNABLE_TO_PARSE', 'CERT_NOT_FOUND', 'SELF_SIGNED_ONLY', 'INVALID_CAPTION']) {
        assert.strictEqual(CountinghouseError.isForeignCode(code), false, code);
      }
    });
    // The X509 codes are an exact list, pinned here. Taken from Node v24.22.2:
    // the 27 OpenSSL names in lib/_tls_wrap.js's 'secureConnection' comment
    // (src/crypto/crypto_common.cc's X509ErrorCode maps them), plus that
    // function's HOSTNAME_MISMATCH. Checked present in the v24.22.2 and
    // v26.13.0 binaries. WHEN THE NODE FLOOR MOVES, re-check this list against
    // the new release's lib/_tls_wrap.js and src/crypto/crypto_common.cc.
    it('pins the X509 verify codes (re-check when the Node floor moves)', () => {
      assert.deepStrictEqual(CountinghouseError.X509_VERIFY_CODES.slice().sort(), [
        'CERT_CHAIN_TOO_LONG', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REJECTED', 'CERT_REVOKED',
        'CERT_SIGNATURE_FAILURE', 'CERT_UNTRUSTED', 'CRL_HAS_EXPIRED', 'CRL_NOT_YET_VALID', 'CRL_SIGNATURE_FAILURE',
        'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERROR_IN_CERT_NOT_AFTER_FIELD', 'ERROR_IN_CERT_NOT_BEFORE_FIELD',
        'ERROR_IN_CRL_LAST_UPDATE_FIELD', 'ERROR_IN_CRL_NEXT_UPDATE_FIELD', 'HOSTNAME_MISMATCH', 'INVALID_CA',
        'INVALID_PURPOSE', 'OUT_OF_MEM', 'PATH_LENGTH_EXCEEDED', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
        'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECRYPT_CRL_SIGNATURE', 'UNABLE_TO_GET_CRL', 'UNABLE_TO_GET_ISSUER_CERT',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      ]);
      assert.strictEqual(CountinghouseError.X509_VERIFY_CODES.length, 28);
    });
    it('passes a CountinghouseError through unchanged, whatever its origin', () => {
      const r = new CountinghouseError('MODULE_RELOADING');
      const m = CountinghouseError.module('MINE');
      assert.strictEqual(CountinghouseError.fromModule(r), r);
      assert.strictEqual(CountinghouseError.fromModule(m), m);
    });
  });

  it('leaves a runtime error\'s catalogue fields alone', () => {
    const r = new CountinghouseError('ADMIN_REQUIRED');
    assert.deepStrictEqual([r.origin, r.kind, r.httpStatus], ['runtime', 'caller', 403]);
  });

  // Review of #37.
  describe('the review of #37', () => {
    const {hopError} = require('../../lib/countinghouse-error');
    it('hopError passes a module\'s error through whole, its own code included', () => {
      const own = CountinghouseError.module('SHAPE_GONE', 'the shape is gone', {n: 1});
      assert.strictEqual(hopError(own), own);
      const named = CountinghouseError.module('DEVICE_NOT_FOUND', 'no row 7', {row: 7});
      assert.strictEqual(hopError(named), named);
      // a callee's plain error with a made-up code is still not passed off as typed
      const plain = Object.assign(new Error('made up'), {code: 'MADE_UP'});
      assert.ok(!(hopError(plain) instanceof CountinghouseError) && hopError(plain).code === undefined);
    });
    it('the plain-Error rule needs an Error: a thrown plain object with a code is a crash', () => {
      assert.strictEqual(CountinghouseError.fromModule({code: 'SHAPE_REJECTED', message: 'x'}), null);
      assert.strictEqual(CountinghouseError.fromModule(Object.create(null)), null);
      class Mine extends Error {}
      assert.ok(CountinghouseError.fromModule(Object.assign(new Mine('m'), {code: 'MINE_CODE'})) instanceof CountinghouseError);
    });
    it('details are a plain non-array object: an array is {}', () => {
      assert.deepStrictEqual(CountinghouseError.module('X_Y', 'm', [1, 2]).details, {});
      const back = CountinghouseError.fromReplyFields({errOrigin: 'module', errCode: 'X_Y', errMsg: 'X_Y: m', errDetails: [1, 2]});
      assert.deepStrictEqual(back.details, {});
    });
    it('makes dropped details visible on the envelope: unserialisable becomes {_details: \'unserialisable\'}', () => {
      const cyc = {}; cyc.self = cyc;
      for (const d of [{n: 1n}, cyc]) {
        const f = CountinghouseError.replyFields(CountinghouseError.module('X_Y', 'm', d));
        assert.deepStrictEqual(f.errDetails, {_details: 'unserialisable'});
      }
    });
    it('replyFields(null) is the success pair', () => {
      assert.deepStrictEqual(CountinghouseError.replyFields(null), {errMsg: null, errCode: null});
      assert.deepStrictEqual(CountinghouseError.replyFields(undefined), {errMsg: null, errCode: null});
    });
  });
});
