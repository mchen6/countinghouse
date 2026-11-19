'use strict';
// The latency gate's workflow fails its job when the gate's verdict is FAIL
// (the maintainer, 11-19): .github/workflows/latency-gate.yml's Measure step
// exits with the highest exit of the modes it runs (gate.js: 0 PASS, 1 FAIL,
// 2 the harness failed), and runs every mode it was asked for first. The
// step's own script is read from the workflow file and run in bash, with a
// stub `node` that exits as each mode is told to: no gate is run.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'latency-gate.yml');

// the Measure step's `run: |` block, its indentation removed
function measureScript() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const at = lines.findIndex((l) => /^\s+- name: Measure\s*$/.test(l));
  assert.ok(at >= 0, 'the workflow has a Measure step');
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  assert.ok(run > at, 'its run block');
  const indent = lines[run + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = run + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

describe('session-runtime 15: the latency gate workflow fails its job on a FAIL verdict', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-gate-wf-'));
    // a stub node: --mode <m> exits with $STUB_<M>, and says what it was asked
    fs.writeFileSync(path.join(dir, 'node'), `${[
      '#!/bin/sh',
      'mode=""; prev=""',
      'for a in "$@"; do [ "$prev" = "--mode" ] && mode="$a"; prev="$a"; done',
      'echo "stub node: $mode" >&2',
      'case "$mode" in closed) exit "${STUB_CLOSED:-0}" ;; open) exit "${STUB_OPEN:-0}" ;; esac',
      'exit 9'
    ].join('\n')}\n`, {mode: 0o755});
    fs.writeFileSync(path.join(dir, 'measure.sh'), measureScript());
  });
  after(() => { fs.rmSync(dir, {recursive: true, force: true}); });

  const step = (env) => spawnSync('bash', [path.join(dir, 'measure.sh')], {cwd: dir, encoding: 'utf8',
    env: {PATH: `${dir}:/usr/bin:/bin`, CLOSED_SESSIONS: '1,2,3,10', CLOSED_ROUNDS: '5', CLOSED_CALLS: '300', OPEN_SESSIONS: '2,3,10', OPEN_CALLS: '60', RUN: '1', ...env}});

  it('exits 0 only when every mode run passed', () => {
    for (const MODES of ['closed', 'open', 'closed,open']) assert.strictEqual(step({MODES}).status, 0, MODES);
  });

  it('a FAIL verdict fails the step (closed N=10 over its limit, as run 44629103496 found), the other mode still run', () => {
    const r = step({MODES: 'closed,open', STUB_CLOSED: '1'});
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /closed: gate exit 1 /);
    assert.match(r.stdout, /open: gate exit 0 /);
    assert.match(r.stderr, /stub node: open/, 'open still runs after closed failed');
    assert.strictEqual(step({MODES: 'open', STUB_OPEN: '1'}).status, 1);
  });

  it('a harness failure fails it too, and wins over a FAIL', () => {
    assert.strictEqual(step({MODES: 'closed,open', STUB_CLOSED: '1', STUB_OPEN: '2'}).status, 2);
    assert.strictEqual(step({MODES: 'closed', STUB_CLOSED: '2'}).status, 2);
  });

  it('modes it does not know are refused as before', () => {
    assert.strictEqual(step({MODES: 'both'}).status, 2);
  });
});
