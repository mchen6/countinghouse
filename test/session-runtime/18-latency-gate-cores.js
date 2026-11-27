'use strict';
// The latency gate's machine condition (the maintainer's gate is measured on
// 4 or more cores: perf/latency-gate/README.md): perf/latency-gate/gate.js
// refuses fewer, as a harness failure (exit 2), with a line saying why;
// --allowFewerCores runs it anyway on a smaller machine, and then the result
// is never PASS or FAIL but "not a gate verdict" (exit 3), in the summary
// line and the JSON. The harness runs on Linux and macOS only, and says the
// true reason on Windows. Required, gate.js runs nothing.
const assert = require('assert');
const path = require('path');

const GATE = path.join(__dirname, '..', '..', 'perf', 'latency-gate', 'gate.js');

describe('session-runtime 18: the latency gate\'s machine: 4 or more CPUs, else refused or no gate verdict', () => {
  const gate = require(GATE);

  it('4 or more CPUs: measured as the gate', () => {
    for (const cpus of [4, 8, 64]) assert.deepStrictEqual(gate.machineCondition(cpus, false), {gated: true}, String(cpus));
    assert.deepStrictEqual(gate.machineCondition(4, true), {gated: true}, 'the flag changes nothing where the gate holds');
  });

  it('fewer: refused with the reason, unless --allowFewerCores, and then no gate verdict', () => {
    for (const cpus of [1, 2, 3]) {
      const c = gate.machineCondition(cpus, false);
      assert.strictEqual(c.gated, false);
      assert.strictEqual(c.refused, `this machine has ${cpus} CPUs; the gate is measured on 4 or more (--allowFewerCores runs it anyway, with no gate verdict)`);
      assert.deepStrictEqual(gate.machineCondition(cpus, true), {gated: false});
    }
  });

  it('the verdict: PASS or FAIL only where the gate holds; otherwise "not a gate verdict", and its own exit', () => {
    const rows = (pass) => [{pass: true}, {pass}];
    assert.deepStrictEqual(gate.verdictOf(rows(true), {gated: true}, 4), {verdict: 'PASS', exitCode: 0});
    assert.deepStrictEqual(gate.verdictOf(rows(false), {gated: true}, 4), {verdict: 'FAIL', exitCode: 1});
    for (const pass of [true, false]) {
      assert.deepStrictEqual(gate.verdictOf(rows(pass), {gated: false}, 3), {verdict: 'not a gate verdict (3 CPUs, fewer than the gate\'s 4)', exitCode: 3});
    }
  });

  it('--allowFewerCores is a flag; Windows is refused with the harness\'s own reason', () => {
    assert.strictEqual(gate.args(['--shim', '/x', '--allowFewerCores']).allowFewerCores, true);
    assert.strictEqual(gate.args(['--shim', '/x']).allowFewerCores, false);
    assert.strictEqual(gate.WINDOWS_REFUSAL, 'this harness runs on Linux and macOS only (it uses a Unix socket and a POSIX script)');
  });
});
