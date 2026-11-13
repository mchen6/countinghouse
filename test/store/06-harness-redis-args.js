// The test harness's --redisUrl for a server start (test/helpers/test-env.js
// redisArgsFor, which sandbox-server.js's startServer uses). Under
// scripts/run-in-docker.js, CH_TEST_REDIS_URL names the container's own
// Redis, and every start got --redisUrl from it -- a --store local start too,
// which refuses one ("choose one", exit 2), so store/05 could not run in the
// harness. Server-free.
const assert = require('assert');
const {redisArgsFor} = require('../helpers/test-env');

describe('store 06: the harness\'s --redisUrl for a server start', () => {
  const URL = 'redis://127.0.0.1:6390';
  let saved;
  beforeEach(() => { saved = process.env.CH_TEST_REDIS_URL; process.env.CH_TEST_REDIS_URL = URL; });
  afterEach(() => {
    if (saved === undefined) delete process.env.CH_TEST_REDIS_URL; else process.env.CH_TEST_REDIS_URL = saved;
  });

  it('none for --store local, in either form', () => {
    assert.deepStrictEqual(redisArgsFor(['--workerThread', '--store', 'local', '--storePath', '/s']), []);
    assert.deepStrictEqual(redisArgsFor(['--store=local', '--workerThread']), []);
  });

  it('none when the test passes its own --redisUrl, in either form', () => {
    assert.deepStrictEqual(redisArgsFor(['--redisUrl', 'redis://127.0.0.1:9733']), []);
    assert.deepStrictEqual(redisArgsFor(['--redisUrl=redis://127.0.0.1:9733']), []);
  });

  it('the harness\'s Redis otherwise: no --store, --store redis, a "local" that is not --store\'s value', () => {
    assert.deepStrictEqual(redisArgsFor(['--workerThread']), ['--redisUrl', URL]);
    assert.deepStrictEqual(redisArgsFor(['--store', 'redis']), ['--redisUrl', URL]);
    assert.deepStrictEqual(redisArgsFor(['--store=redis']), ['--redisUrl', URL]);
    assert.deepStrictEqual(redisArgsFor(['--storePath', 'local']), ['--redisUrl', URL]);
  });

  it('none at all without CH_TEST_REDIS_URL (outside the harness, as before)', () => {
    delete process.env.CH_TEST_REDIS_URL;
    assert.deepStrictEqual(redisArgsFor(['--workerThread']), []);
    assert.deepStrictEqual(redisArgsFor(['--store', 'local']), []);
  });
});
