'use strict';
// Shared runtime B5, Task 1 (docs/superpowers/plans/2026-11-16-shared-runtime-b5-session-views.md):
// the usage report per session. In a shared runtime every session has the
// user's one key, so the caller rule alone would show A every session's
// calls. usageReport(args, {caller, isAdmin, session}): a string session
// keeps only that session's records, after the caller rule and whatever
// isAdmin says; undefined is today's report, unchanged. A record with no
// session is in no session's report. Server-free: records in memory and in
// files.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createUsage} = require('../../lib/usage');
const {usageReport} = require('../../lib/usage/report');
const {streamUsage} = require('../../lib/usage/read');

const NOW = Date.parse('2026-11-16T13:00:00.000Z');
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

describe('usage 21: the usage report per session (shared runtime B5, Task 1)', () => {
  let dir;
  // A: one pack call with a server call that ended in an error code only A met; B: a call of its own pack,
  // a module and server A never touched, and a code only B met; one call with no session
  const live = () => {
    let t = NOW - 5000;
    const u = createUsage({usageDir: null, pid: 7, startMs: NOW - 9000, now: () => t++});
    const a = u.beginCall({scenario: 'ch-pack-alpha', module: 'ch-pack-alpha', tool: 'alpha_tool', caller: 'u_me', session: A});
    u.recordIn(a, {server: 'alpha-server', module: 'ch-access-alpha', tool: 'alpha_read', bytes: 100, lines: 10, ms: 1, outcome: 'ok', credential: null});
    u.recordOut(a, {tool: 'alpha_tool', bytes: 40, lines: 4, ms: 9, outcome: 'error', code: 'ALPHA_ONLY_CODE'});
    const b = u.beginCall({scenario: 'ch-pack-bravo', module: 'ch-pack-bravo', tool: 'bravo_tool', caller: 'u_me', session: B});
    u.recordIn(b, {server: 'bravo-server', module: 'ch-access-bravo', tool: 'bravo_read', bytes: 300, lines: 30, ms: 1, outcome: 'error', credential: null, code: 'BRAVO_ONLY_CODE'});
    // (B's server call with no result yet: its session's all the same)
    const b2 = u.beginCall({scenario: 'ch-pack-bravo', module: 'ch-pack-bravo', tool: 'bravo_tool', caller: 'u_me', session: B});
    u.recordIn(b2, {server: 'bravo-server', module: 'ch-access-bravo', tool: 'bravo_open', bytes: 5, lines: 1, ms: 1, outcome: 'ok', credential: null});
    u.recordOut(b, {tool: 'bravo_tool', bytes: 60, lines: 6, ms: 9, outcome: 'error', code: 'BRAVO_ONLY_CODE'});
    const n = u.beginCall({scenario: null, module: 'plain', tool: 'nobody_tool', caller: 'u_me'});
    u.recordOut(n, {tool: 'nobody_tool', bytes: 1, lines: 1, ms: 1, outcome: 'ok'});
    return u;
  };
  // the same in an earlier process's file, and a line whose tool name carries A's session text but is B's
  const writeFile = () => {
    const day = path.join(dir, '2026-11-16');
    fs.mkdirSync(day, {recursive: true});
    const at = (s) => `2026-11-16T10:00:0${s}.000Z`;
    const lines = [
      {t: at(1), call: 1, pack: 'ch-pack-alpha', module: 'ch-pack-alpha', tool: 'alpha_tool', bytesOut: 10, linesOut: 1, ms: 1, outcome: 'ok', caller: 'u_me', session: A},
      {t: at(2), call: 2, pack: 'ch-pack-bravo', module: 'ch-pack-bravo', tool: 'bravo_tool', bytesOut: 10, linesOut: 1, ms: 1, outcome: 'ok', caller: 'u_me', session: B},
      {t: at(3), call: 3, pack: 'ch-pack-bravo', module: 'ch-pack-bravo', tool: `trick"session":"${A}"`, bytesOut: 10, linesOut: 1, ms: 1, outcome: 'ok', caller: 'u_me', session: B},
      {t: at(4), call: 4, pack: null, module: 'plain', tool: 'nobody_tool', bytesOut: 10, linesOut: 1, ms: 1, outcome: 'ok', caller: 'u_me'}
    ];
    fs.writeFileSync(path.join(day, '5-1.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-s-'));
    writeFile();
  });
  afterEach(() => { fs.rmSync(dir, {recursive: true, force: true}); });
  const run = (args, who, u = live()) => usageReport(args, who, {usage: u, usageDir: dir, now: () => NOW});
  const B_NAMES = /bravo|BRAVO_ONLY_CODE|trick/;
  const A_NAMES = /alpha|ALPHA_ONLY_CODE/;

  it('A\'s report counts A\'s calls only, in memory and in files, and names nothing of B\'s, for every groupBy', async() => {
    for (const groupBy of ['tool', 'server', 'scenario', 'module']) {   // (the day rows, kept-out totals and profiling are in each)
      const out = await run({since: '2026-11-16', groupBy}, {caller: 'u_me', isAdmin: false, session: A});
      const text = JSON.stringify(out);
      assert.ok(!B_NAMES.test(text), `${groupBy}: ${text.slice(0, 600)}`);
      assert.ok(!/nobody_tool/.test(text), `${groupBy}: a record with no session is in no session's report`);
      assert.ok(!text.includes(A) && !text.includes(B), 'no session id in it');
    }
    const byTool = await run({since: '2026-11-16'}, {caller: 'u_me', isAdmin: false, session: A});
    assert.deepStrictEqual(byTool.groups.filter((g) => g.tool === 'alpha_tool').map((g) => g.calls), [2], 'one in memory, one in the file');
  });

  it('B\'s report has B\'s calls, its server call with no result yet included, and nothing of A\'s', async() => {
    const out = await run({since: '2026-11-16', groupBy: 'server'}, {caller: 'u_me', isAdmin: false, session: B});
    const text = JSON.stringify(out);
    assert.ok(!A_NAMES.test(text), text.slice(0, 600));
    assert.deepStrictEqual(out.groups.filter((g) => g.server === 'bravo-server').map((g) => g.serverCalls), [2]);
  });

  it('isAdmin true with a session is still that session\'s report', async() => {
    const out = await run({since: '2026-11-16'}, {caller: 'u_admin', isAdmin: true, session: A});
    const text = JSON.stringify(out);
    assert.ok(!B_NAMES.test(text) && !/nobody_tool/.test(text), text.slice(0, 600));
  });

  it('with session undefined the report is today\'s: every record of the caller, sessions and none', async() => {
    const out = await run({since: '2026-11-16'}, {caller: 'u_me', isAdmin: false});
    const tools = out.groups.map((g) => g.tool).sort();
    assert.deepStrictEqual(tools, ['(no result recorded)', 'alpha_tool', 'bravo_tool', 'nobody_tool', `trick"session":"${A}"`].sort());
    assert.deepStrictEqual(out.groups.find((g) => g.tool === 'bravo_tool').calls, 2);
  });

  it('the file reader skips a line that can\'t be the session\'s before parsing, and checks every kept one again', async() => {
    const kept = await streamUsage(dir, {since: '2026-11-16', until: '2026-11-17', caller: 'u_me', session: A});
    assert.deepStrictEqual(kept.map((r) => r.tool), ['alpha_tool'], 'the trick line carries A\'s text but is B\'s');
  });
});
