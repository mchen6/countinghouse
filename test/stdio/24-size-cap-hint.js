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
    assert.match(callLimits.raiseHint(300 * MiB), /"value":"256MiB".*\(256MiB is the most it can be\)/);
  });

  it('without it: the operator\'s flag', () => {
    options.settingsTool = false;
    assert.strictEqual(callLimits.raiseHint(9 * MiB + 1), `the operator's --maxOutputBytes ${10 * MiB}`);
  });

  it('in the error\'s text, in English and in Chinese', () => {
    options.settingsTool = true;
    for (const [code, locale] of [['OUTPUT_TOO_LARGE', 'en-US'], ['INPUT_TOO_LARGE', 'zh-CN']]) {
      options.locale = locale;
      const e = CountinghouseError.withFields(code, {module: 'm', action: 'a', bytes: 5000, max: 3000, raise: callLimits.raiseHint(5000)});
      assert.match(e.message, /ch-local settings set maxOutputBytes 1MiB/, `${code} ${locale}: ${e.message}`);
      assert.match(e.message, locale === 'en-US' ? /To allow more: / : /如需放宽：/);
    }
  });

  it('spawned under --stdio with --settingsFile: a module\'s output over the cap names the ch-local command (the worker\'s own check)', async () => {
    const home = tmp.mkdtemp('ch-s24-');
    const callee = path.join(__dirname, '..', 'fixtures', 'hop-input-callee');
    const io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--settingsFile', path.join(home, 'settings.json'), '--maxOutputBytes', '3000',
      '--authConfigPath', path.join(__dirname, '..', 'sandbox', '48-auth.json'), '--loadModule', callee], {env: {COUNTINGHOUSE_API_KEY: 'hop-input-key'}});
    try {
      const init = await io.request({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test', version: '1'}}});
      assert.ok(init.result != null, JSON.stringify(init));
      const list = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
      const big = list.result.tools.find((t) => /hop.input.callee/i.test(t.name) && /(^|_)big$/.test(t.name));
      assert.ok(big != null, JSON.stringify(list.result.tools.map((t) => t.name)));
      const r = await io.request({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: big.name, arguments: {n: 5000}}});
      const text = JSON.stringify(r);
      assert.match(text, /OUTPUT_TOO_LARGE|over the 3000-byte limit/, text.slice(0, 600));
      assert.match(text, /ch-local settings set maxOutputBytes 1MiB/, text.slice(0, 600));
    } finally {
      io.child.kill('SIGKILL');
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
});
