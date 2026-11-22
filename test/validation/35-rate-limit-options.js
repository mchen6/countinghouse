// --apiKeyRateLimit and --globalRateLimit take a positive integer, calls a
// second. Anything else (0, a word, a negative, a fraction, the bare flag)
// used to reach the limiter's constructor, whose assertion threw: not a
// startup error that names the option. Now the start stops with exit 2 and
// says which option and what it got, as for the other limits (the final
// pass's gateway part, A6). The refusals stop before the server listens.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');
const {testPort, redisUrlFor} = require('../helpers/test-env');

const ROOT = path.resolve(__dirname, '../..');

function parsed(argv) {
  const script = `
    const options = require(${JSON.stringify(path.join(ROOT, 'lib', 'cli-options'))});
    options.setOptions(${JSON.stringify(argv)});
    process.stdout.write(JSON.stringify({apiKeyRateLimit: options.apiKeyRateLimit, globalRateLimit: options.globalRateLimit, invalid: options.rateLimitInvalid}));`;
  const run = spawnSync(process.execPath, ['-e', script], {cwd: ROOT, encoding: 'utf8', timeout: 20000});
  assert.strictEqual(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function start(args) {
  // (the test's own Redis, never the default: on a red run, old code, a bad
  // value let the server start -- the medium on this PR, 7)
  return spawnSync(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(testPort(9829)), '--redisUrl', redisUrlFor()].concat(args),
    {cwd: ROOT, encoding: 'utf8', timeout: 30000});
}

describe('validation 35: --apiKeyRateLimit and --globalRateLimit take a positive integer (A6)', function() {
  this.timeout(120000);

  it('a positive integer is taken; none is no limit', () => {
    assert.deepStrictEqual(parsed({apiKeyRateLimit: 5, globalRateLimit: 100}), {apiKeyRateLimit: 5, globalRateLimit: 100, invalid: null});
    assert.deepStrictEqual(parsed({apiKeyRateLimit: '7'}), {apiKeyRateLimit: 7, globalRateLimit: null, invalid: null});
    assert.deepStrictEqual(parsed({}), {apiKeyRateLimit: null, globalRateLimit: null, invalid: null});
  });

  for (const name of ['apiKeyRateLimit', 'globalRateLimit']) {
    for (const bad of ['0', 'abc', '-1', '2.5']) {
      it(`--${name} ${bad} stops the start with exit 2, naming it`, () => {
        const run = start([`--${name}=${bad}`]);
        assert.strictEqual(run.status, 2, `${run.status} ${run.stderr.slice(-400)}`);
        assert.ok(run.stderr.includes(`--${name} must be a positive integer, calls a second (got "${bad}")`), run.stderr.slice(-400));
      });
    }
    it(`--${name} with no value stops the start with exit 2`, () => {
      const run = start([`--${name}`]);
      assert.strictEqual(run.status, 2, `${run.status} ${run.stderr.slice(-400)}`);
      assert.ok(run.stderr.includes(`--${name} must be a positive integer`), run.stderr.slice(-400));
    });
  }
});
