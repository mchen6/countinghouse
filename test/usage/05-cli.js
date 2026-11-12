// bin/countinghouse-usage.js: the same report for the operator's shell, from
// the usage files (local-mode spec §5), every caller by opaque id, as text,
// --json or --csv.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {writeUsageFixture} = require('../helpers/usage-fixture');
const {usageReport} = require('../../lib/usage/report');

const BIN = path.join(__dirname, '..', '..', 'bin', 'countinghouse-usage.js');
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8', timeout: 20000});

describe('countinghouse-usage', () => {
  let dir;
  beforeEach(() => { dir = writeUsageFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-cli-'))); });
  afterEach(() => { fs.rmSync(dir, {recursive: true, force: true}); });

  it('--json prints the report of the files, the same numbers as the tool for the same window', () => {
    const r = run('--usageDir', dir, '--since', '2026-11-10', '--json');
    assert.strictEqual(r.status, 0, r.stderr);
    const printed = JSON.parse(r.stdout);
    const expected = usageReport({since: '2026-11-10'}, {caller: null, isAdmin: true}, {usage: null, usageDir: dir, now: () => Date.parse(printed.window.until)});
    assert.deepStrictEqual(printed, expected);
    assert.deepStrictEqual(printed.source, ['files']);
  });

  it('prints text by default and CSV with --csv, the token columns marked as estimates', () => {
    const text = run('--usageDir', dir, '--groupBy', 'server');
    assert.strictEqual(text.status, 0, text.stderr);
    assert.match(text.stdout, /github: \d+ calls, \d+ server calls/);
    assert.match(text.stdout, /estimate \(utf8 bytes \/ 4\)/);
    assert.doesNotMatch(text.stdout, /saved/i);
    const csv = run('--usageDir', dir, '--csv');
    assert.strictEqual(csv.stdout.split('\n')[0], 'caller,tool,server,pack,module,calls,server_calls,bytes_in,lines_in,bytes_out,lines_out,tokens_in_est,tokens_out_est');
  });

  it('refuses what it does not understand, with its usage', () => {
    for (const bad of [[], ['--usageDir'], ['--usageDir', dir, '--since', 'soon'], ['--usageDir', dir, '--json', '--csv'], ['--usageDir', dir, '--bogus']]) {
      const r = run(...bad);
      assert.strictEqual(r.status, 2, bad.join(' '));
      assert.match(r.stderr, /usage: countinghouse-usage/);
    }
  });
});
