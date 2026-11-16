// MCP completeness M3, spec section 1: `contentEncoding: "base64"` is an
// assertion in countinghouse's validator, not ajv's annotation. The value must
// be canonical RFC 4648 base64: the standard alphabet, padded, no whitespace,
// zero pad bits. Any other contentEncoding stays an annotation. It holds in
// both of the validator's ajv instances (the shared one, which single-thread
// mode compiles with, and each validator worker's), so on every path, inputs
// and outputs alike.
const assert = require('assert');
const validator = require('../../lib/validator');
const {serialize, toArrayBuffer} = require('../../lib/serialized-result');

const BIN = {type: 'object', properties: {data: {type: 'string', contentEncoding: 'base64', contentMediaType: 'image/png'}}};

const CANONICAL = ['', 'AA==', 'AAA=', 'AAAA', 'Zm9vYmFy', 'Zm9vYg==', 'Zm9vYmE=', '+/+/', Buffer.from([0, 255, 1, 254, 2]).toString('base64')];
const NOT = {
  'a pad bit set (two pads)': 'AB==',
  'a pad bit set (one pad)': 'AAB=',
  'whitespace': 'Zm9v YmFy',
  'a newline': 'Zm9v\nYmFy',
  'the URL alphabet': '-_-_',
  'a length not a multiple of 4': 'Zm9vY',
  'no padding': 'Zm9vYg',
  'an = inside': 'Zm=vYmFy',
  'three pads': 'A===',
  'an = then data': 'AA==AAAA',
  'a non-ASCII letter': 'Zm9vYmFé'
};

function instances() {
  return {shared: validator.getSchemaValidator(), worker: validator.createSchemaValidator()};
}

describe('validation 17: contentEncoding "base64" asserts canonical base64', () => {
  for (const [label, ajv] of Object.entries(instances())) {
    describe(`the ${label} ajv instance`, () => {
      const check = ajv.compile(BIN);
      for (const s of CANONICAL) {
        it(`accepts ${JSON.stringify(s)}`, () => assert.strictEqual(check({data: s}), true, JSON.stringify(check.errors)));
      }
      for (const [why, s] of Object.entries(NOT)) {
        it(`refuses ${why}`, () => {
          assert.strictEqual(check({data: s}), false);
          assert.strictEqual(check.errors[0].keyword, 'contentEncoding');
          assert.strictEqual(check.errors[0].instancePath, '/data');
          assert.match(check.errors[0].message, /canonical base64/);
        });
      }
      it('another contentEncoding stays an annotation', () => {
        const other = ajv.compile({type: 'string', contentEncoding: 'base32'});
        assert.strictEqual(other('not base32 at all!'), true);
      });
      it('applies to strings only (a non-string is the type keyword\'s)', () => {
        const any = ajv.compile({contentEncoding: 'base64'});
        assert.strictEqual(any(12), true);
        assert.strictEqual(any({}), true);
      });
    });
  }

  it('single-thread mode: validator.validate refuses a non-canonical value with the field named', (done) => {
    const ajv = validator.getSchemaValidator();
    validator.validate('output', {schema: BIN, validator: ajv.compile(BIN)}, {data: 'AB=='}, (err, info) => {
      assert.strictEqual(err, 'data validation failed');
      assert.match(JSON.stringify(info), /data/);
      done();
    });
  });

  it('a 16 MiB value is checked in bounded time, canonical or not', () => {
    const check = validator.createSchemaValidator().compile(BIN);
    const big = Buffer.alloc(12 * 1024 * 1024, 7).toString('base64'); // 16 MiB of base64
    let t = process.hrtime.bigint();
    assert.strictEqual(check({data: big}), true);
    const okMs = Number(process.hrtime.bigint() - t) / 1e6;
    const bad = `${big.slice(0, -4)}A=A=`;
    t = process.hrtime.bigint();
    assert.strictEqual(check({data: bad}), false);
    const badMs = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(okMs < 1000 && badMs < 1000, `canonical ${okMs.toFixed(0)} ms, not ${badMs.toFixed(0)} ms`);
  });

  describe('through the validator pool (each worker\'s instance): an output and an input', function() {
    this.timeout(60000);
    const SERVICE = 'urn:countinghouse-test:serviceID:bin';
    const api = {device: {friendlyName: 'bin', manufacturer: 't', modelDescription: 'binary fields',
      serviceList: {[SERVICE]: {actionList: [{name: 'put', description: 'puts', input: {schema: '/bin/put/input'}, output: {schema: '/bin/put/output'}}]}}}};
    const schema = {$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object', bin: {put: {input: BIN, output: BIN}}};
    let pool = null;
    before(() => {
      const options = require('../../lib/cli-options');
      options.setOptions({workerThread: true});
      const {ValidatorPool} = require('../../lib/validator-pool');
      pool = new ValidatorPool({size: 1, timeoutMs: 20000, compileMs: 20000, workerOptions: options.getOptionsForWorker()});
      pool.register('bin#1', 'bin', JSON.stringify(api), JSON.stringify(schema));
    });
    after(() => {
      if (pool != null) pool.close();
      require('../../lib/cli-options').setOptions({workerThread: false});
    });
    const outputOf = async (data) => {
      const b = serialize({output: {data}});
      return pool.checkSerialized('bin#1', SERVICE, 'put', 'output', toArrayBuffer(b));
    };
    it('a canonical output passes; a non-canonical one is refused naming the field', async () => {
      assert.strictEqual((await outputOf('Zm9vYg==')).refused, null);
      const r = await outputOf('Zm9vYh==');
      assert.notStrictEqual(r.refused, null);
      assert.match(JSON.stringify(r.refused), /data/);
    });
    it('an input is checked the same way', async () => {
      assert.strictEqual(await pool.check('bin#1', SERVICE, 'put', 'input', {input: {data: 'AAA='}}), null);
      const r = await pool.check('bin#1', SERVICE, 'put', 'input', {input: {data: 'AAA'}});
      assert.notStrictEqual(r, null);
      assert.match(JSON.stringify(r), /data/);
    });
  });
});
