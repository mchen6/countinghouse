'use strict';
// The second golden (MCP completeness M2, spec section 4): the tools/list
// surface of the fixture that declares everything
// (test/fixtures/declares-everything), in both eras, as one runtime serves
// it over --stdio. 23-tools-list-everything.js asserts it is unchanged.
//
//   node test/mcp-contract/capture-tools-list-everything.js [outfile]
//
// Regenerate only when the fixture's tool surface is meant to change. Its
// first capture is the one M2 made; no task regenerates
// tools-list.golden.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, INITIALIZE, MODERN_META} = require('../helpers/stdio-client');
const {testPort} = require('../helpers/test-env');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'declares-everything');
const GOLDEN = path.join(__dirname, 'tools-list-everything.golden.json');
const KEY = 'stdio-test-key';

// -> {legacy: [tools], modern: [tools]}: the fixture's own tools, as listed
async function capture({workerThread = true} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-everything-'));
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}), {mode: 0o600});
  const io = startStdio([workerThread ? '--workerThread' : '--no-workerThread', '--loadModule', FIXTURE, '--authConfigPath', auth,
    '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`], {env: {COUNTINGHOUSE_API_KEY: KEY}});
  try {
    const init = await io.request({...INITIALIZE, id: 1});
    if (init.result == null) throw new Error(`initialize: ${JSON.stringify(init)}`);
    if (await waitForTool(io, /notesservice_savenote$/) == null) throw new Error(`the fixture never listed:\n${io.err.slice(-2000)}`);
    const own = (r) => r.result.tools.filter((t) => /notesservice_/.test(t.name));
    const legacy = own(await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}));
    const modern = own(await io.request({jsonrpc: '2.0', id: 3, method: 'tools/list', params: {_meta: MODERN_META}}));
    return {legacy, modern};
  } finally {
    await io.stop();
    fs.rmSync(home, {recursive: true, force: true});
  }
}

module.exports = {capture, GOLDEN};

if (require.main === module) {
  capture().then((got) => {
    const out = process.argv[2] || GOLDEN;
    fs.writeFileSync(out, `${JSON.stringify(got, null, 2)}\n`);
    process.stdout.write(`wrote ${out}: ${got.legacy.length} tools\n`);
    process.exit(0);
  }, (err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
