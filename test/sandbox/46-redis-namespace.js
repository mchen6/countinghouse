// #164: ctx.redis is per module. Two modules on one runtime share its key
// space (Redis db 5, here the local store's kv), so the main thread puts
// every key a module names under m:<module name>:, by the name it loaded the
// module under. Module A cannot read, write or delete module B's keys; a
// multi-key command and a transaction stay in the namespace; a command whose
// keys cannot be placed is refused; the namespace is main's, whatever the
// worker's message says.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

const KEY = 'k';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'redis-ns');

// The fixture under another name.
function copy(base, name) {
  const dir = path.join(base, name);
  fs.cpSync(FIXTURE, dir, {recursive: true});
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({...pkg, name}));
  fs.writeFileSync(path.join(dir, 'api.json'), fs.readFileSync(path.join(dir, 'api.json'), 'utf8').replace('"friendlyName": "redis-ns"', `"friendlyName": "${name}"`));
  return dir;
}

for (const [label, thread, port] of [['worker', '--workerThread', 9736], ['single-thread', '--no-workerThread', 9737]]) {
  describe(`sandbox 46: ctx.redis is per module (#164), ${label}`, function() {
    this.timeout(120000);
    let server = null;
    let base = null;
    const run = async (mod, op, args) => toolOutput(await mcpCall(port, KEY, `redis_ns_${mod}_nsservice_run`, {op, args}));
    before(async () => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-redis-ns-'));
      server = await startServer(port, [thread, '--debug', '--debugKey', KEY, '--store', 'local', '--storePath', path.join(base, 'store'),
        '--moduleDataPath', path.join(base, 'module_data'), '--loadModule', copy(base, 'redis-ns-a'), '--loadModule', copy(base, 'redis-ns-b')]);
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('module A cannot read, overwrite or delete module B\'s key of the same name', async () => {
      assert.strictEqual((await run('a', 'set', ['shared', 'from-a'])).error, null);
      assert.strictEqual((await run('b', 'get', ['shared'])).result, null, 'B does not see A\'s key');
      assert.strictEqual((await run('b', 'set', ['shared', 'from-b'])).error, null);
      assert.strictEqual((await run('b', 'del', ['shared'])).result, 1);
      assert.strictEqual((await run('a', 'get', ['shared'])).result, 'from-a', 'B\'s set and del touched only its own');
    });

    it('a multi-key command stays inside the module\'s namespace', async () => {
      await run('a', 'set', ['x', '1']);
      await run('b', 'set', ['y', '2']);
      assert.deepStrictEqual((await run('a', 'mget', ['x', 'y'])).result, ['1', null], 'A\'s mget does not reach B\'s y');
      assert.strictEqual((await run('a', 'del', ['x', 'y'])).result, 1, 'A\'s del removes only its own x');
      assert.strictEqual((await run('b', 'get', ['y'])).result, '2');
    });

    it('hmset with a {field: value} object works, in the module\'s namespace', async () => {
      assert.strictEqual((await run('a', 'hmset', ['h', {f: 'v', g: 'w'}])).error, null);
      assert.strictEqual((await run('a', 'hget', ['h', 'g'])).result, 'w');
      assert.strictEqual((await run('b', 'hget', ['h', 'g'])).result, null);
    });

    it('multi, exec and a command whose keys cannot be placed are refused', async () => {
      for (const [op, args] of [['multi', [[['set', 't', '1'], ['get', 't']]]], ['multi', [[['select', 0], ['exec']]]], ['exec', []]]) {
        const r = await run('a', op, args);
        assert.ok(r.error != null, `${op}: ${JSON.stringify(r)}`);
      }
      assert.match((await run('a', 'get', [])).error, /needs a key/);
    });

    it('an error names the key without the namespace', async () => {
      await run('a', 'set', ['str', 'v']);
      const r = await run('a', 'hget', ['str', 'f']);
      assert.ok(r.error != null, JSON.stringify(r));
      assert.doesNotMatch(r.error, /m:redis-ns-a:/);
    });

    if (label === 'worker') {
      it('the namespace is the one main loaded the module under, whatever the worker\'s message names', async () => {
        await run('b', 'set', ['target', 'b-own']);
        const forged = toolOutput(await mcpCall(port, KEY, 'redis_ns_a_nsservice_forge', {op: 'set', args: ['target', 'forged'], as: 'redis-ns-b'}));
        assert.strictEqual(forged.error, null, JSON.stringify(forged));
        assert.strictEqual((await run('b', 'get', ['target'])).result, 'b-own', 'B\'s key is untouched');
        assert.strictEqual((await run('a', 'get', ['target'])).result, 'forged', 'the forged write landed in A\'s own namespace');
      });

      it('a forged multi or exec is refused on the main thread', async () => {
        for (const op of ['multi', 'exec']) {
          const r = toolOutput(await mcpCall(port, KEY, 'redis_ns_a_nsservice_forge', {op, args: [[['select', 0], ['exec']]], as: 'redis-ns-a'}));
          assert.match(String(r.error), /not a supported redis command/, op);
        }
      });

      it('a key spelled with another module\'s prefix stays in the sender\'s namespace', async () => {
        await run('b', 'set', ['secret', 'b-only']);
        assert.strictEqual((await run('a', 'get', ['m:redis-ns-b:secret'])).result, null);
      });
    }
  });
}
