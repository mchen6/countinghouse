'use strict';
// The latency gate's workflow (the maintainer, 11-19): the open run, at
// realistic load, is the release gate, and a FAIL verdict there fails the
// job; the closed run's verdict is recorded only (the log and the step's
// summary) and never fails it. A harness failure (a crash with no result,
// a signal, gate.js's own 2) fails it in either mode, and every mode asked
// for still runs. .github/workflows/latency-gate.yml's Measure step script
// is read from the workflow file and run as Actions runs a step (bash
// --noprofile --norc -eo pipefail), with a stub `node` that exits as each
// mode is told to: no gate is run.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'latency-gate.yml');

// the Measure step's `run: |` block, its indentation (the first non-blank
// line's) removed
function measureScript() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const at = lines.findIndex((l) => /^\s+- name: Measure\s*$/.test(l));
  assert.ok(at >= 0, 'the workflow has a Measure step');
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  assert.ok(run > at, 'its run block');
  const first = lines.findIndex((l, i) => i > run && l.trim() !== '');
  const indent = lines[first].match(/^\s*/)[0].length;
  assert.ok(indent > lines[run].match(/^\s*/)[0].length, 'the block is indented under its run:');
  const body = [];
  for (let i = run + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

describe('session-runtime 15: the latency gate workflow: the open run fails the job on FAIL, the closed run is recorded only', () => {
  // (a POSIX shell script, as the workflow's ubuntu runner runs it)
  if (process.platform === 'win32') return;
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-gate-wf-'));
    // a stub node: --mode <m> exits with $STUB_<M>; on a 1 it writes its
    // --json result as gate.js does for a FAIL verdict, unless STUB_CRASH
    // names the mode (a crash exits 1 with none)
    fs.writeFileSync(path.join(dir, 'node'), `${[
      '#!/bin/sh',
      'mode=""; json=""; prev=""',
      'for a in "$@"; do [ "$prev" = "--mode" ] && mode="$a"; [ "$prev" = "--json" ] && json="$a"; prev="$a"; done',
      'echo "stub node: $mode" >&2',
      'case "$mode" in closed) c="${STUB_CLOSED:-0}" ;; open) c="${STUB_OPEN:-0}" ;; *) exit 9 ;; esac',
      '[ "$c" = 1 ] && [ "$STUB_CRASH" != "$mode" ] && echo \'{"verdict":"FAIL"}\' > "$json"',
      'exit "$c"'
    ].join('\n')}\n`, {mode: 0o755});
    fs.writeFileSync(path.join(dir, 'measure.sh'), measureScript());
  });
  after(() => { fs.rmSync(dir, {recursive: true, force: true}); });

  // each step in a fresh directory (a result file is the run's own), with
  // its step summary -> {status, stdout, stderr, summary}
  const step = (env) => {
    const cwd = fs.mkdtempSync(path.join(dir, 'run-'));
    const summary = path.join(cwd, 'summary.md');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', path.join(dir, 'measure.sh')], {cwd, encoding: 'utf8',
      env: {PATH: `${dir}:/usr/bin:/bin`, GITHUB_STEP_SUMMARY: summary, CLOSED_SESSIONS: '1,2,3,10', CLOSED_ROUNDS: '5', CLOSED_CALLS: '300',
        OPEN_SESSIONS: '2,3,10', OPEN_CALLS: '60', RUN: '1', ...env}});
    return {...r, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : ''};
  };

  it('exits 0 when every mode run passed, in either order', () => {
    for (const MODES of ['closed', 'open', 'closed,open', 'open,closed']) assert.strictEqual(step({MODES}).status, 0, MODES);
  });

  it('the open run\'s FAIL fails the job, the closed run still run, in either order', () => {
    const r = step({MODES: 'closed,open', STUB_OPEN: '1'});
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /open: gate exit 1 /);
    assert.match(r.summary, /- open \(realistic load\): FAIL, the release gate/);
    assert.strictEqual(step({MODES: 'open,closed', STUB_OPEN: '1'}).status, 1);
    assert.strictEqual(step({MODES: 'open', STUB_OPEN: '1'}).status, 1);
  });

  it('the closed run\'s FAIL (as run 44629103496 found at N=10) is recorded, and the job stays green', () => {
    for (const MODES of ['closed', 'closed,open', 'open,closed']) {
      const r = step({MODES, STUB_CLOSED: '1'});
      assert.strictEqual(r.status, 0, `${MODES}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /closed: gate exit 1 /);
      assert.match(r.summary, /- closed \(back to back\): FAIL, recorded only, not the release gate/);
    }
    assert.match(step({MODES: 'closed,open', STUB_CLOSED: '1'}).stderr, /stub node: open/, 'open still runs');
  });

  it('the harness failing fails the job in either mode, as 2: its own exit, a crash with no result, a signal', () => {
    assert.strictEqual(step({MODES: 'closed', STUB_CLOSED: '2'}).status, 2);
    assert.strictEqual(step({MODES: 'open', STUB_OPEN: '2'}).status, 2);
    const crash = step({MODES: 'closed', STUB_CLOSED: '1', STUB_CRASH: 'closed'});
    assert.strictEqual(crash.status, 2, crash.stdout);
    assert.match(crash.summary, /closed \(back to back\): the harness failed/);
    const killed = step({MODES: 'closed,open', STUB_OPEN: '137'});
    assert.strictEqual(killed.status, 2, killed.stdout);
    assert.match(killed.stdout, /open: gate exit 2 /);
    // and it wins over an open FAIL
    assert.strictEqual(step({MODES: 'closed,open', STUB_CLOSED: '2', STUB_OPEN: '1'}).status, 2);
  });

  it('modes it does not know are refused as before', () => {
    assert.strictEqual(step({MODES: 'both'}).status, 2);
  });
});
