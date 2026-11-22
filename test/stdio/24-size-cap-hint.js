'use strict';
// A size cap's error tells the agent how to raise the cap (the business
// decision-coverage audit, 2026-11-15): with the settings tool served
// (ch-local's --settingsFile), the countinghouse_settings call and the
// terminal command, with the size needed in whole MiB; on a server without
// it, the operator's --maxOutputBytes. Language-neutral, in every locale.
// The worker learns which from its options (settingsTool), never the
// settings file's path.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

const MiB = 1024 * 1024;

describe('stdio 24: a size cap\'s error says how to raise it', function() {
  this.timeout(120000);
  const options = require('../../lib/cli-options');
  const callLimits = require('../../lib/call-limits');
  const {CountinghouseError} = require('../../lib/countinghouse-error');
  let saved;
  beforeEach(() => { saved = {settingsTool: options.settingsTool, locale: options.locale}; });
  afterEach(() => Object.assign(options, saved));

  it('with the settings tool: the tool\'s call and the terminal command, at the size needed in MiB', () => {
    options.settingsTool = true;
    const h = callLimits.raiseHint(9 * MiB + 1);
    assert.match(h, /countinghouse_settings \{"action":"set","name":"maxOutputBytes","value":"10MiB"\}/);
    assert.match(h, /`ch-local settings set maxOutputBytes 10MiB` in a terminal/);
    assert.match(callLimits.raiseHint(10), /"value":"1MiB"/, 'never under the setting\'s 1MiB');
    const over = callLimits.raiseHint(300 * MiB, 256 * MiB);
    assert.strictEqual(over, 'the most allowed here is 256MiB', 'past the setting\'s bound: the most, and no command');
  });

  it('bounded by the operator\'s ceiling: a 64 MiB ceiling caps the hint, and a size past it gets the most and no command', () => {
    options.settingsTool = true;
    const most = callLimits.ceilingBound({state: 'trusted', ceiling: {maxOutputBytes: 64 * MiB}});
    assert.strictEqual(most, 64 * MiB);
    assert.match(callLimits.raiseHint(9 * MiB, most), /`ch-local settings set maxOutputBytes 9MiB`/);
    const past = callLimits.raiseHint(100 * MiB, most);
    assert.strictEqual(past, 'the most allowed here is 64MiB');
    assert.ok(!/settings set|countinghouse_settings/.test(past));
    // no ceiling: the setting's own 256MiB; one that can't be trusted: no raise; one without the cap: 256MiB
    assert.strictEqual(callLimits.ceilingBound({state: 'none'}), 256 * MiB);
    assert.strictEqual(callLimits.ceilingBound({state: 'untrusted', problem: 'x'}), null);
    assert.strictEqual(callLimits.ceilingBound({state: 'trusted', ceiling: {}}), 256 * MiB);
    assert.match(callLimits.raiseHint(9 * MiB, null), /no raise in conversation here: the operator's ceiling can't be trusted/);
  });

  it('without it: the operator\'s flag', () => {
    options.settingsTool = false;
    assert.strictEqual(callLimits.raiseHint(9 * MiB + 1), `the operator's --maxOutputBytes ${10 * MiB}`);
  });

  it('in the error\'s text', () => {
    options.settingsTool = true;
    for (const code of ['OUTPUT_TOO_LARGE', 'INPUT_TOO_LARGE']) {
      const e = CountinghouseError.withFields(code, {module: 'm', action: 'a', bytes: 5000, max: 3000, raise: callLimits.raiseHint(5000)});
      assert.match(e.message, /ch-local settings set maxOutputBytes 1MiB/, `${code}: ${e.message}`);
      assert.match(e.message, /To allow more: /);
    }
  });

  ['audit', 'enforce'].forEach((mode) => it(`spawned under --stdio with --settingsFile, ${mode}: a module's output over the cap names the ch-local command (the worker's own check)`, async () => {
    const home = tmp.mkdtemp('ch-s24-');
    // in the single-identity profile, as ch-local runs it (--settingsFile is
    // refused anywhere else): the callee a scenario, which the profile lists
    const callee = path.join(home, 'hop-input-callee');
    fs.cpSync(path.join(__dirname, '..', 'fixtures', 'hop-input-callee'), callee, {recursive: true});
    const pkgPath = path.join(callee, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.countinghouse = Object.assign({}, pkg.countinghouse, {role: 'scenario'});
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--settingsFile', path.join(home, 'settings.json'), '--maxOutputBytes', '3000',
      '--moduleSandbox', mode, '--loadModule', callee]);
    try {
      const init = await io.request({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test', version: '1'}}});
      assert.ok(init.result != null, JSON.stringify(init));
      const list = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
      const big = list.result.tools.find((t) => t.name === 'big');
      assert.ok(big != null, JSON.stringify(list.result.tools.map((t) => t.name)));
      const r = await io.request({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: big.name, arguments: {n: 5000}}});
      const text = JSON.stringify(r);
      assert.match(text, /OUTPUT_TOO_LARGE|over the 3000-byte limit/, text.slice(0, 600));
      assert.match(text, /ch-local settings set maxOutputBytes 1MiB/, text.slice(0, 600));
    } finally {
      // the home holds what the runtime writes: removed once it has exited
      if (io.child.exitCode == null && io.child.signalCode == null) { io.child.kill('SIGKILL'); await new Promise((r) => io.child.once('exit', r)); }
      fs.rmSync(home, {recursive: true, force: true});
    }
  }));
});
