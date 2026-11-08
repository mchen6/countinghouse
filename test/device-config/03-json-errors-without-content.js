// A syntax error in an operator's JSON file is reported by line and column
// only, never with the text around it: V8's JSON.parse messages quote the
// input near the error, and these files hold secrets -- a module's backend
// credentials in its device config, env values in the --modulePolicy file.
const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');

const SECRET = `s${crypto.randomBytes(12).toString('hex')}`;
const pieces = Array.from({length: SECRET.length - 5}, (_, i) => SECRET.slice(i, i + 6));
const noPiece = (text, where) => pieces.forEach((p) => assert.ok(!text.includes(p), `${where} contains "${p}", part of the secret`));

describe('device-config 03: JSON errors without the file\'s content', function() {
  this.timeout(60000);
  let base = null;
  afterEach(() => { if (base != null) fs.rmSync(base, {recursive: true, force: true}); base = null; });

  it('a device config with a syntax error right after a secret is logged by line and column only', async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-json-errors-'));
    // Unquoted, so V8 says "Unexpected token 's', ..." and quotes the secret.
    fs.writeFileSync(path.join(base, 'fs-probe.json'), `{\n  "apiSecret": ${SECRET}\n}\n`);
    const server = await startServer(9629, ['--workerThread', '--debug', '--debugKey', 'k', '--deviceConfigPath', base,
      '--moduleDataPath', path.join(base, 'store')]);
    try {
      await post(9629, 'k', '/load-module', {path: path.join(ROOT, 'test', 'fixtures', 'fs-probe'), name: 'fs-probe'});
      await new Promise((r) => setTimeout(r, 500));
      assert.match(server.output, /Failed to get app config info/);
      assert.match(server.output, /not valid JSON at line 2, column \d+/);
      noPiece(server.output, 'the server log');
    } finally {
      stopServer(server);
    }
  });

  it('a --modulePolicy file with an "Unexpected token" error is located, and none of it is quoted', () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-json-errors-'));
    const file = path.join(base, 'policy.json');
    fs.writeFileSync(file, `{"modules": {"m": {"env": {"TOKEN": "${SECRET}" oops}}}}`);
    let message = null;
    try { require('../../lib/module-policy').load(file); } catch (e) { message = e.message; }
    assert.ok(message != null, 'the policy was accepted');
    assert.match(message, /not valid JSON at line 1, column \d+/);
    noPiece(message, 'the policy error');
  });
});
