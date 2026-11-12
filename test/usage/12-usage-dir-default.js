// The usage files' default (LM1 spec §5, the reviewer's ruling 2026-11-12):
// under --store local, --usageDir defaults to <storePath>/usage/, so every
// launcher that shares a store writes one record of usage across agents;
// under --store redis it is explicit-only (a hosted operator opts in to disk
// writes). An explicit --usageDir wins either way.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'bin', 'countinghouse-stdio.js');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'usage-scenario');
const KEY = 'usage-dir-key';

describe('usage: where the usage files go by default', function() {
  this.timeout(60000);
  let home;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-dir-')); });
  afterEach(() => { fs.rmSync(home, {recursive: true, force: true}); });

  it('the option: <storePath>/usage under --store local, unset under --store redis, an explicit one wins', () => {
    const options = require('../../lib/cli-options');
    const store = path.join(home, 'store');
    options.setOptions({redisUrl: 'redis://127.0.0.1:9749', store: 'local', storePath: store});
    assert.strictEqual(options.usageDir, path.join(store, 'usage'));
    assert.strictEqual(options.getOptions().usageDir, path.join(store, 'usage'));
    options.setOptions({redisUrl: 'redis://127.0.0.1:9749', store: 'local', storePath: store, usageDir: path.join(home, 'mine')});
    assert.strictEqual(options.usageDir, path.join(home, 'mine'));
    options.setOptions({redisUrl: 'redis://127.0.0.1:9749', store: 'redis'});
    assert.strictEqual(options.usageDir, null);
    options.setOptions({redisUrl: 'redis://127.0.0.1:9749'});
    assert.strictEqual(options.usageDir, null, 'redis is the default store');
  });

  // B's local store refuses to start until it is complete ("--store local is
  // not complete in this build"); until then this case skips, saying why, and
  // runs by itself once the store lands.
  it('a --store local start with no --usageDir writes its usage under <storePath>/usage/<day>/', async function() {
    const store = path.join(home, 'store');
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'u', devices: ['*']}}));
    const child = spawn(process.execPath, [ENTRY, '--workerThread', '--store', 'local', '--storePath', store, '--loadModule', FIXTURE,
      '--authConfigPath', auth, '--moduleDataPath', path.join(home, 'module_data')],
    {env: {...process.env, COUNTINGHOUSE_API_KEY: KEY}, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    let exited = false;
    child.on('exit', () => { exited = true; });
    const answer = (id) => new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const look = () => {
        const found = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === id);
        if (found) return resolve(found);
        if (exited) return reject(new Error(`exited before answering ${id}; stderr: ${err.slice(-1500)}`));
        if (Date.now() > deadline) return reject(new Error(`no answer ${id}; stderr: ${err.slice(-1500)}`));
        return setTimeout(look, 100);
      };
      look();
    });
    try {
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 't', version: '0'}}})}\n`);
      try {
        await answer(1);
      } catch (e) {
        if (/--store local is not complete in this build/.test(err)) this.skip();
        throw e;
      }
      // The module may still be loading: list until the scenario is there.
      let listed = false;
      for (let i = 2; i < 60 && !listed; i++) {
        child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: i, method: 'tools/list', params: {}})}\n`);
        listed = ((await answer(i)).result.tools || []).some((t) => t.name === 'usage_probe');
        if (!listed) await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(listed, 'the scenario was listed');
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 100, method: 'tools/call', params: {name: 'usage_probe', arguments: {}}})}\n`);
      const call = await answer(100);
      assert.strictEqual(call.result.isError, false, JSON.stringify(call));
      const usage = path.join(store, 'usage');
      const days = fs.existsSync(usage) ? fs.readdirSync(usage) : [];
      assert.strictEqual(days.length, 1, `usage days under ${usage}: ${JSON.stringify(days)}`);
      const files = fs.readdirSync(path.join(usage, days[0]));
      assert.strictEqual(files.length, 1);
      const records = fs.readFileSync(path.join(usage, days[0], files[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.deepStrictEqual(records.map((r) => [r.tool, r.outcome]), [['usage_probe', 'ok']]);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
