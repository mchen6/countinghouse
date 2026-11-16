// MCP completeness M5, spec section 2: the result store's options.
// --resourceRetention (seconds; 24 h, from 1 minute to 7 days),
// --resourceStoreBytes (512 MiB under --store redis, 4 GiB under local),
// --resourceQuotaBytes (128 MiB under redis, 256 MiB under local),
// --resourceQuotaItems (1024). One stored value is at most three quarters of
// --maxOutputBytes. Anything else exits 2 at start, naming the option.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');
const {testPort} = require('../helpers/test-env');

const ROOT = path.resolve(__dirname, '../..');
const MIB = 1024 * 1024;

function limitsFor(argv) {
  const script = `
    const options = require(${JSON.stringify(path.join(ROOT, 'lib', 'cli-options'))});
    options.setOptions(${JSON.stringify(argv)});
    process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(ROOT, 'lib', 'store', 'blobs'))}).limitsFromOptions(options)));
  `;
  const run = spawnSync(process.execPath, ['-e', script], {cwd: ROOT, encoding: 'utf8', timeout: 20000});
  assert.strictEqual(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function start(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(testPort(9579))].concat(args),
    {cwd: ROOT, encoding: 'utf8', timeout: 20000});
}

describe('store 08: the result store\'s options (M5)', function() {
  this.timeout(60000);

  it('the defaults follow the store', () => {
    assert.deepStrictEqual(limitsFor({}), {retentionMs: 86400000, storeBytes: 512 * MIB, quotaBytes: 128 * MIB, quotaItems: 1024, itemBytes: 12 * MIB});
    assert.deepStrictEqual(limitsFor({store: 'local', storePath: '/tmp/ch-store-08'}),
      {retentionMs: 86400000, storeBytes: 4096 * MIB, quotaBytes: 256 * MIB, quotaItems: 1024, itemBytes: 12 * MIB});
  });

  it('each is taken as given; one value is three quarters of the output cap', () => {
    assert.deepStrictEqual(limitsFor({resourceRetention: 60, resourceStoreBytes: 1000, resourceQuotaBytes: 500, resourceQuotaItems: 3, maxOutputBytes: 4000}),
      {retentionMs: 60000, storeBytes: 1000, quotaBytes: 500, quotaItems: 3, itemBytes: 3000});
    assert.strictEqual(limitsFor({resourceRetention: 604800}).retentionMs, 604800000);
  });

  it('--store local with --storePath under --moduleDataPath exits 2 at start, naming --storePath', () => {
    const r = start(['--store', 'local', '--moduleDataPath', '/tmp/ch-store-08/module_data', '--storePath', '/tmp/ch-store-08/module_data/store']);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /--storePath must be outside --moduleDataPath/);
  });

  for (const [args, name] of [
    [['--resourceRetention', '59'], 'resourceRetention'],
    [['--resourceRetention', '604801'], 'resourceRetention'],
    [['--resourceRetention', '1.5'], 'resourceRetention'],
    [['--resourceStoreBytes', '0'], 'resourceStoreBytes'],
    [['--resourceQuotaBytes', '-1'], 'resourceQuotaBytes'],
    [['--resourceQuotaItems', '0'], 'resourceQuotaItems'],
    [['--resourceQuotaItems', 'many'], 'resourceQuotaItems']
  ]) {
    it(`${args.join(' ')} exits 2, naming --${name}`, () => {
      const r = start(args);
      assert.strictEqual(r.status, 2, r.stderr);
      assert.match(r.stderr, new RegExp(`--${name} must be`));
    });
  }
});
