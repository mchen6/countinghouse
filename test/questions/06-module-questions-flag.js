'use strict';
// MCP completeness M13: --moduleQuestions. On unless turned off; a value it
// does not know stops the start (it must never read as "on": the operator
// who wrote it meant something).
const assert = require('assert');

describe('questions 06: --moduleQuestions (MCP completeness M13)', () => {
  const cli = require('../../lib/cli-options');
  after(() => cli.setOptions({workerThread: false}));

  it('on by default, and for on and true; off for off and false', () => {
    cli.setOptions({workerThread: false});
    assert.deepStrictEqual([cli.moduleQuestions, cli.moduleQuestionsInvalid], [true, null]);
    for (const v of ['on', 'true', true]) {
      cli.setOptions({workerThread: false, moduleQuestions: v});
      assert.deepStrictEqual([cli.moduleQuestions, cli.moduleQuestionsInvalid], [true, null], String(v));
    }
    for (const v of ['off', 'false', false]) {
      cli.setOptions({workerThread: false, moduleQuestions: v});
      assert.deepStrictEqual([cli.moduleQuestions, cli.moduleQuestionsInvalid], [false, null], String(v));
    }
  });

  // #311's CI (stdio 02): --hardened's relaunch gives every flag twice, so its value arrives as a list.
  // Unread, a list is "a value it does not know": --hardened --moduleQuestions off did not start.
  it('given twice, as --hardened\'s relaunch gives it, it counts by its last value', () => {
    for (const [given, on] of [[['off', 'off'], false], [['on', 'on'], true], [['on', 'off'], false], [['off', 'on'], true], [['false', 'false'], false]]) {
      cli.setOptions({workerThread: false, moduleQuestions: given});
      assert.deepStrictEqual([cli.moduleQuestions, cli.moduleQuestionsInvalid], [on, null], JSON.stringify(given));
    }
    cli.setOptions({workerThread: false, moduleQuestions: ['off', 'no']});
    assert.deepStrictEqual(cli.moduleQuestionsInvalid, {name: 'moduleQuestions', value: 'no', what: 'on or off'}, 'the last value is the one read, and refused if it is none');
  });

  it('any other value is refused, and until it is the questions are off: never on by a value it could not read', () => {
    for (const v of ['no', '0', 0, 'OFF', 'Off', 'disabled', '', 'yes', 1]) {
      cli.setOptions({workerThread: false, moduleQuestions: v});
      assert.deepStrictEqual(cli.moduleQuestionsInvalid, {name: 'moduleQuestions', value: v, what: 'on or off'}, String(v));
      assert.strictEqual(cli.moduleQuestions, false, String(v));
    }
  });

  it('the start stops on it, exit 2, saying what it takes', function() {
    this.timeout(90000);
    const {spawnSync} = require('child_process');
    const path = require('path');
    const out = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'framework.js'), '--workerThread', '--port', String(require('../helpers/test-env').testPort(9655)), '--moduleQuestions', 'no'], {encoding: 'utf8', timeout: 60000});
    assert.strictEqual(out.status, 2, out.stderr.slice(0, 300));
    assert.match(out.stderr, /--moduleQuestions must be on or off \(got "no"\)/);
  });
});
