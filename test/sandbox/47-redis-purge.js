// #164 follow-up: POST /uninstall-module deletes the module's ctx.redis keys
// (its m:<name>:* namespace) with its data, so a later module of the same
// name inherits none of them. keepData keeps them; a reload keeps them; a
// neighbour's keys are never touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

const KEY = 'k';
const PORT = 9738;
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'redis-ns');

function copy(base, name) {
  const dir = path.join(base, name);
  fs.cpSync(FIXTURE, dir, {recursive: true});
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({...pkg, name}));
  fs.writeFileSync(path.join(dir, 'api.json'), fs.readFileSync(path.join(dir, 'api.json'), 'utf8').replace('"friendlyName": "redis-ns"', `"friendlyName": "${name}"`));
  return dir;
}

describe('sandbox 47: an uninstalled module\'s ctx.redis keys go with it (#164)', function() {
  this.timeout(180000);
  let server = null;
  let base = null;
  let a = null;
  const run = async (mod, op, args) => toolOutput(await mcpCall(PORT, KEY, `redis_ns_${mod}_nsservice_run`, {op, args}));
  // The module answers again (after a load or a reload).
  const back = () => waitFor(async () => {
    try { return (await mcpCall(PORT, KEY, 'redis_ns_a_nsservice_run', {op: 'get', args: ['probe']})).structuredContent != null; } catch (e) { return false; }
  }, 60000, 'redis-ns-a back');
  const unloadThenUninstall = async (body) => {
    assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'redis-ns-a'})).status, 200);
    const r = await post(PORT, KEY, '/uninstall-module', {name: 'redis-ns-a', ...body});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await post(PORT, KEY, '/load-module', {path: a})).status, 200);
    await back();
    return r.body;
  };

  before(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-redis-purge-'));
    a = copy(base, 'redis-ns-a');
    server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', KEY, '--store', 'local', '--storePath', path.join(base, 'store'),
      '--moduleDataPath', path.join(base, 'module_data'), '--loadModule', a, '--loadModule', copy(base, 'redis-ns-b')]);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('a reload keeps the module\'s keys', async () => {
    await run('a', 'set', ['k', 'kept']);
    await run('b', 'set', ['k', 'b-own']);
    assert.strictEqual((await post(PORT, KEY, '/reload-module', {path: a})).status, 200);
    await back();
    assert.strictEqual((await run('a', 'get', ['k'])).result, 'kept');
  });

  it('an uninstall with keepData keeps them', async () => {
    const body = await unloadThenUninstall({keepData: true});
    assert.strictEqual(body.keysDeleted, null, 'not attempted');
    assert.strictEqual((await run('a', 'get', ['k'])).result, 'kept');
  });

  it('an uninstall deletes them: a module loaded again under the name starts with none, and the neighbour keeps its own', async () => {
    await run('a', 'hset', ['h', 'f', 'v']);
    const body = await unloadThenUninstall({});
    assert.strictEqual(body.keysDeleted, 2, JSON.stringify(body));
    assert.strictEqual((await run('a', 'get', ['k'])).result, null);
    assert.strictEqual((await run('a', 'hget', ['h', 'f'])).result, null);
    assert.strictEqual((await run('b', 'get', ['k'])).result, 'b-own');
  });
});
