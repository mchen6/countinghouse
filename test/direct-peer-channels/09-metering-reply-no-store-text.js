'use strict';
// A peer hop's metering reply to the callee worker (which logs it, module-
// reachable) carries a code and the catalogue's own words only, never the
// store's message: on the local store that names the ledger's path.
const assert = require('assert');
const {CountinghouseError} = require('../../lib/countinghouse-error');

describe('direct-peer-channels 09: the callee worker is told a charge failed by its code alone', () => {
  const {meteringReplyOf} = require('../../lib/peer-channel-broker');
  const storeSays = '/home/someone/.countinghouse/store/metering.json: EACCES, permission denied';

  it('a catalogue code: the code and the catalogue\'s words, no store message', () => {
    const err = new CountinghouseError('LEDGER_UNWRITABLE', storeSays);
    assert.ok(err.message.includes(storeSays), 'the store\'s message is on the error itself');
    const fields = meteringReplyOf(err);
    assert.strictEqual(fields.errCode, 'LEDGER_UNWRITABLE');
    assert.strictEqual(fields.errMsg, new CountinghouseError('LEDGER_UNWRITABLE').message);
    assert.ok(!JSON.stringify(fields).includes('metering.json') && !JSON.stringify(fields).includes('/home/'), JSON.stringify(fields));
  });

  it('anything else: "metering unavailable", the code kept when it has a code\'s form, never its message', () => {
    assert.deepStrictEqual(meteringReplyOf(Object.assign(new Error(storeSays), {code: 'EACCES'})), {errMsg: 'metering unavailable', errCode: 'EACCES'});
    for (const err of [new Error(storeSays), Object.assign(new Error(storeSays), {code: 'not a code /home/x'}), null]) {
      assert.deepStrictEqual(meteringReplyOf(err), {errMsg: 'metering unavailable'}, String(err && err.code));
    }
    // (a code read through a getter that throws: still an answer, never a throw)
    const hostile = {}; Object.defineProperty(hostile, 'code', {get() { throw new Error('no'); }});
    assert.deepStrictEqual(meteringReplyOf(hostile), {errMsg: 'metering unavailable'});
  });
});
