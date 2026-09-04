const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const spawn   = require('child_process').spawnSync;

// Every HTTP entry path owes a docs/cross-cutting-matrix.md row, an auth story
// and a metering story, forever. /callbacks stayed unauthenticated for years
// because nobody had enumerated the routes, and the matrix records that same
// shape recurring four times. This makes the enumeration mechanical: a new
// mount fails here until it is written down.
//
// Mirrors the golden tools/list contract the pre-commit hook already enforces
// for the MCP surface.
const ROOT    = path.join(__dirname, '..', '..');
const HELPER  = path.join(ROOT, 'test', 'fixtures', 'route-inventory.js');
const GOLDEN  = path.join(ROOT, 'test', 'fixtures', 'route-inventory.json');

function readInventory(extraEnv) {
  const res = spawn(process.execPath, [HELPER], {
    cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, extraEnv || {})
  });
  assert.strictEqual(res.status, 0,
    `route-inventory helper exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

describe('module-loading 11: the HTTP route inventory is declared', function() {
  this.timeout(30000);

  it('every mounted path is in the golden inventory, and vice versa', () => {
    const actual = readInventory();
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));

    const added   = actual.filter((p) => golden.indexOf(p) === -1);
    const removed = golden.filter((p) => actual.indexOf(p) === -1);

    assert.deepStrictEqual({added: added, removed: removed}, {added: [], removed: []},
      'The mounted HTTP routes no longer match test/fixtures/route-inventory.json.\n' +
      `  added (mounted but not declared): ${JSON.stringify(added)}\n` +
      `  removed (declared but not mounted): ${JSON.stringify(removed)}\n` +
      'If you added a route: add its row to docs/cross-cutting-matrix.md -- auth, ' +
      'metering, rate limit, timeout, error shape -- then regenerate the golden file ' +
      'with:\n  node ./test/fixtures/route-inventory.js > ./test/fixtures/route-inventory.json\n' +
      'A missing matrix row is worse than a blank cell.');
  });

  // Without this the test above could pass by comparing two empty lists, or by
  // silently reporting nothing when express internals move.
  it('the inventory is non-empty and contains the known-live routes', () => {
    const actual = readInventory();
    assert.ok(actual.length >= 15, `implausibly small inventory: ${JSON.stringify(actual)}`);
    for (const known of ['/mcp', '/balance', '/devices/:deviceID/invoke-action']) {
      assert.ok(actual.indexOf(known) !== -1, `expected ${known} in the inventory`);
    }
  });

  it('the removed IoT-era paths are absent', () => {
    const actual = readInventory();
    for (const gone of ['/devices/:deviceID/connect', '/devices/:deviceID/disconnect',
                        '/load-profile', '/v2/:tenantID/servers']) {
      assert.strictEqual(actual.indexOf(gone), -1, `${gone} is mounted again`);
    }
  });
});
