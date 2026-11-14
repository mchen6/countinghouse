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

describe('countinghouse-usage', function() {
  // each case spawns the command line, several in a row
  this.timeout(30000);
  let dir;
  beforeEach(() => { dir = writeUsageFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-cli-'))); });
  afterEach(() => { fs.rmSync(dir, {recursive: true, force: true}); });

  it('--json prints the report of the files, the same numbers as the tool for the same window', async () => {
    const r = run('--usageDir', dir, '--since', '2026-11-10', '--json');
    assert.strictEqual(r.status, 0, r.stderr);
    const printed = JSON.parse(r.stdout);
    const expected = (await usageReport({since: '2026-11-10'}, {caller: null, isAdmin: true}, {usage: null, usageDir: dir, now: () => Date.parse(printed.window.until)}));
    assert.deepStrictEqual(printed, expected);
    assert.deepStrictEqual(printed.source, ['files']);
  });

  it('prints text by default and CSV with --csv, the token columns marked as estimates', async () => {
    const text = run('--usageDir', dir, '--groupBy', 'server');
    assert.strictEqual(text.status, 0, text.stderr);
    assert.match(text.stdout, /github: \d+ calls, \d+ server calls/);
    assert.match(text.stdout, /estimate \(utf8 bytes \/ 4\)/);
    assert.doesNotMatch(text.stdout, /saved/i);
    const csv = run('--usageDir', dir, '--csv');
    assert.strictEqual(csv.stdout.split('\n')[0], 'caller,tool,server,pack,module,calls,server_calls,bytes_in,lines_in,bytes_out,lines_out,tokens_in_est,tokens_out_est');
  });

  it('--since all --until a day: the window\'s days first, then the period\'s totals with the upper-bound estimate', async () => {
    const r = run('--usageDir', dir, '--since', 'all', '--until', '2026-11-10');
    assert.strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^usage from 2026-11-09 to 2026-11-10 \(window: all records to 2026-11-10T23:59:59\.999Z\)/);
    assert.match(lines[1], /^period: 2 calls, 3 server calls; about [\d,]+ fewer tokens: kept out of the model's context, an upper-bound estimate/);
    assert.match(r.stdout, /^by day:$/m);
    assert.match(r.stdout, /^profile: /m);
    assert.doesNotMatch(r.stdout, /sav(e|ed|ing)|lower bill|cost/i);
  });

  it('the shell\'s report lists every group: the 500-row bound is the tool\'s', async () => {
    const {createUsage} = require('../../lib/usage');
    const u = createUsage({usageDir: null, pid: 3, startMs: 1, now: () => Date.parse('2026-11-13T10:00:00Z')});
    for (let i = 0; i < 510; i++) u.recordOut(u.beginCall({pack: 'p', tool: `t${i}`, caller: 'u_a'}), {tool: `t${i}`, bytes: 1, lines: 1, ms: 1, outcome: 'ok'});
    const who = {caller: null, isAdmin: true};
    assert.strictEqual((await usageReport({}, who, {usage: u, usageDir: null})).groups.length, 500);
    const all = (await usageReport({}, who, {usage: u, usageDir: null, maxGroups: Infinity}));
    assert.deepStrictEqual([all.groups.length, all.groupsOmitted], [510, 0]);
  });

  it('refuses what it does not understand, with its usage', async () => {
    for (const bad of [[], ['--usageDir'], ['--usageDir', dir, '--since', 'soon'], ['--usageDir', dir, '--until', 'later'],
      ['--usageDir', dir, '--since', '2026-11-11', '--until', '2026-11-10'], ['--usageDir', dir, '--json', '--csv'], ['--usageDir', dir, '--bogus']]) {
      const r = run(...bad);
      assert.strictEqual(r.status, 2, bad.join(' '));
      assert.match(r.stderr, /usage: countinghouse-usage/);
    }
  });
});
