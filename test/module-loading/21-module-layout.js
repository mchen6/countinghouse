// One module format (lean worker, step 1; Matt, 2026-11-13): a module is
// api.json, schema.json and handlers/<service>/<action>.js, decided from
// static facts on the main thread. A main entry (package.json "main", or
// index.js) with no handlers/ directory is refused with
// MODULE_LAYOUT_UNSUPPORTED, before any of the module's code runs; with a
// handlers/ directory, a main entry is never run.
// - lib/module-layout.js's rule, server-free;
// - countinghouse-validate reports it at the "layout" stage, with the code;
// - the load path: countinghouse_load_module answers the code, in the
//   worker and in single-thread mode; a --loadModule at start logs the text
//   and the server goes on.
// The modules are written to a temporary directory. A main entry that runs
// calls process.exit(7): in single-thread mode that ends the server, in a
// worker it ends the load, and in the validator's child it ends the check.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const {mkdtemp, remove} = require('../helpers/test-tmp');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');

const ROOT = path.join(__dirname, '..', '..');
const VALIDATE = path.join(ROOT, 'bin', 'countinghouse-validate.js');
const KEY = 'module-loading-21-key';
const EXITS = 'process.exit(7);\n';

// A module named `name` under `dir`: api.json and schema.json, plus
// handlers/ when `handlers`, plus a main entry: `main` names package.json's
// "main" (written with EXITS), or `indexJs` writes index.js with no "main".
function writeModule(dir, name, {handlers = false, main = null, indexJs = false} = {}) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', ...(main != null ? {main} : {})}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test', modelDescription: `${name}: module-loading 21`,
    serviceList: {'urn:countinghouse-test:serviceID:layoutService': {actionList: [{name: 'ping', description: 'ping (module-loading 21)',
      input: {schema: '/layoutService/ping/input'}, output: {schema: '/layoutService/ping/output'}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    layoutService: {ping: {input: {type: 'object'}, output: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}}}}));
  if (handlers) {
    fs.mkdirSync(path.join(dir, 'handlers', 'layoutService'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'handlers', 'layoutService', 'ping.js'), "module.exports = async () => ({output: {text: 'pong'}});\n");
  }
  if (main != null) fs.writeFileSync(path.join(dir, main), EXITS);
  if (indexJs) fs.writeFileSync(path.join(dir, 'index.js'), EXITS);
  return dir;
}

describe('module-loading 21: one module format, decided statically', function() {
  this.timeout(120000);
  let home = null;
  before(() => { home = mkdtemp('module-loading-21-'); });
  after(() => { if (home != null) remove(home); });

  describe('the rule (lib/module-layout.js)', () => {
    // Required by each case, so a missing module fails the cases, not the file.
    const layoutRefusal = (...args) => require('../../lib/module-layout').layoutRefusal(...args);

    it('a "main" with no handlers/ directory is refused, naming the module and the format', () => {
      const dir = writeModule(path.join(home, 'rule-main'), 'rule-main', {main: 'device.js'});
      const e = layoutRefusal(dir, 'rule-main');
      assert.ok(e != null);
      assert.strictEqual(e.code, 'MODULE_LAYOUT_UNSUPPORTED');
      assert.match(e.message, /rule-main/);
      assert.match(e.message, /handlers\/<service>\/<action>\.js/);
      assert.match(e.message, /docs\/module-development\.md/);
      assert.match(e.message, /this one has package\.json "main": "device\.js" and no handlers\/ directory/, 'names the file that triggered it');
    });

    it('the name is filled in by the error\'s formatter from a field, which no serialised form carries', () => {
      const dir = writeModule(path.join(home, 'rule-fields'), 'rule-fields', {main: 'device.js'});
      const e = layoutRefusal(dir, 'rule-fields');
      assert.deepStrictEqual(e.fields, {name: 'rule-fields', file: 'package.json "main": "device.js"'});
      assert.ok(!/\{(name|file)\}/.test(e.message), e.message);
      assert.deepStrictEqual(Object.keys(JSON.parse(JSON.stringify(e))), ['code', 'message']);
    });

    it('rebuilt from a worker\'s reply, it keeps the text it was sent, fields filled in', () => {
      const {CountinghouseError} = require('../../lib/countinghouse-error');
      const e = layoutRefusal(writeModule(path.join(home, 'rule-reply'), 'rule-reply', {main: 'device.js'}), 'rule-reply');
      const back = CountinghouseError.fromReply(JSON.parse(JSON.stringify(e)));
      assert.strictEqual(back.code, 'MODULE_LAYOUT_UNSUPPORTED');
      assert.strictEqual(back.message, e.message);
    });

    it('an index.js with no "main" and no handlers/ directory is refused too', () => {
      const dir = writeModule(path.join(home, 'rule-index'), 'rule-index', {indexJs: true});
      const e = layoutRefusal(dir, 'rule-index') || {};
      assert.strictEqual(e.code, 'MODULE_LAYOUT_UNSUPPORTED');
      assert.match(e.message, /this one has index\.js and no handlers\/ directory/, 'names the file that triggered it');
    });

    it('a "main" that names no file there (npm init\'s "index.js") is not a main entry', () => {
      const dir = path.join(home, 'rule-main-missing');
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'rule-main-missing', version: '1.0.0', main: 'index.js'}));
      assert.strictEqual(layoutRefusal(dir, 'rule-main-missing'), null);
      assert.strictEqual(require('../../lib/module-layout').mainEntry(dir), null);
      fs.writeFileSync(path.join(dir, 'lib.js'), EXITS);
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'rule-main-missing', version: '1.0.0', main: 'lib'}));
      assert.strictEqual(require('../../lib/module-layout').mainEntry(dir), 'package.json "main": "lib"', 'resolved as Node would, with .js');
    });

    it('a handlers/ directory is the format, with or without a main entry', () => {
      assert.strictEqual(layoutRefusal(writeModule(path.join(home, 'rule-both'), 'rule-both', {handlers: true, main: 'device.js'}), 'rule-both'), null);
      assert.strictEqual(layoutRefusal(writeModule(path.join(home, 'rule-handlers'), 'rule-handlers', {handlers: true}), 'rule-handlers'), null);
    });
  });

  describe('countinghouse-validate', () => {
    const validate = (dir) => {
      const r = spawnSync(process.execPath, [VALIDATE, '--json', dir], {encoding: 'utf8', timeout: 60000});
      return {status: r.status, out: (() => { try { return JSON.parse(r.stdout); } catch (e) { return {raw: r.stdout, stderr: r.stderr}; } })()};
    };

    it('reports MODULE_LAYOUT_UNSUPPORTED at the "layout" stage, with the same text, and runs no main entry', () => {
      const r = validate(writeModule(path.join(home, 'validate-main'), 'validate-main', {main: 'device.js'}));
      assert.strictEqual(r.status, 1, JSON.stringify(r.out));
      const p = (r.out.problems || []).find((x) => x.stage === 'layout');
      assert.ok(p != null, JSON.stringify(r.out));
      assert.strictEqual(p.code, 'MODULE_LAYOUT_UNSUPPORTED');
      assert.match(p.message, /validate-main.*handlers\/<service>\/<action>\.js/s);
    });

    it('a module with handlers/ and a main entry is clean, its main entry is not run, and a warning says it never is', () => {
      const r = validate(writeModule(path.join(home, 'validate-both'), 'validate-both', {handlers: true, main: 'device.js'}));
      assert.strictEqual(r.status, 0, JSON.stringify(r.out));
      assert.strictEqual(r.out.ok, true);
      const w = (r.out.warnings || []).filter((x) => x.stage === 'layout');
      assert.strictEqual(w.length, 1, JSON.stringify(r.out.warnings));
      assert.match(w[0].message, /package\.json "main": "device\.js" is never run/);
    });

    it('a handler file that throws is one problem, not also "no handlers/ directory"', () => {
      const dir = writeModule(path.join(home, 'validate-throws'), 'validate-throws', {handlers: true});
      fs.writeFileSync(path.join(dir, 'handlers', 'layoutService', 'ping.js'), "throw new Error('handler-throws-21');\n");
      const r = validate(dir);
      assert.strictEqual(r.status, 1, JSON.stringify(r.out));
      assert.deepStrictEqual(r.out.problems.map((p) => p.stage), ['resolveHandlerMap'], JSON.stringify(r.out.problems));
      assert.match(r.out.problems[0].message, /handler-throws-21/);
    });
  });

  [
    ['in a worker', ['--workerThread', '--validationCompileMs', '1000']],
    ['in single-thread mode', ['--no-workerThread']]
  ].forEach(([where, flags]) => {
    describe(`the load path, ${where}`, () => {
      let io = null;
      let id = 1;
      const load = async (dir, name) => {
        const r = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/call', params: {name: 'countinghouse_load_module', arguments: {path: dir, name}}}, 60000);
        return r.result;
      };

      before(async () => {
        const run = path.join(home, `run-${flags[0].replace(/\W/g, '')}`);
        fs.mkdirSync(run, {recursive: true});
        const auth = path.join(run, 'auth.json');
        fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'module-loading-21', devices: ['*'], admin: true}}));
        const atStart = writeModule(path.join(run, 'start-main'), 'start-main', {main: 'device.js'});
        io = startStdio([...flags, '--authoringTools', '--authConfigPath', auth, '--store', 'local', '--storePath', path.join(run, 'store'),
          '--moduleDataPath', path.join(run, 'module_data'), '--modulePath', path.join(run, 'modules'), '--loadModule', atStart],
        {env: {COUNTINGHOUSE_API_KEY: KEY}});
        await io.request({...INITIALIZE, id: id++}, 60000);
      });
      after(async () => { if (io != null) await io.stop(); });

      it('a --loadModule with a main entry and no handlers/ is refused at start with the text, and the server goes on', async () => {
        const deadline = Date.now() + 30000;
        while (!/start-main: a module is api\.json, schema\.json and handlers/.test(io.err) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        assert.match(io.err, /start-main: a module is api\.json, schema\.json and handlers/);
        const listed = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/list'}, 30000);
        assert.ok(Array.isArray(listed.result.tools));
        assert.ok(!listed.result.tools.some((t) => /start_main/.test(t.name)));
      });

      it('countinghouse_load_module answers MODULE_LAYOUT_UNSUPPORTED, and runs no module code', async () => {
        const dir = writeModule(path.join(home, `load-main-${id}`), 'load-main', {main: 'device.js'});
        const r = await load(dir, 'load-main');
        assert.strictEqual(r.isError, true, JSON.stringify(r));
        assert.strictEqual(r._meta['countinghouse/code'], 'MODULE_LAYOUT_UNSUPPORTED', JSON.stringify(r));
      });

      // The module format's schema, with `input` as ping's input and `extra`
      // beside it in schema.json (lib/schema-safety.js).
      const withInput = (dir, name, input, extra = {}) => {
        writeModule(dir, name, {handlers: true});
        const schema = JSON.parse(fs.readFileSync(path.join(dir, 'schema.json'), 'utf8'));
        schema.layoutService.ping.input = input;
        fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({...schema, ...extra}));
        return dir;
      };

      it('a schema whose pattern can backtrack catastrophically is refused at load; a plain pattern loads', async () => {
        const bad = withInput(path.join(home, `load-redos-${id}`), 'load-redos', {type: 'object', properties: {s: {type: 'string', pattern: '^(a+)+$'}}});
        const r = await load(bad, 'load-redos');
        assert.strictEqual(r.isError, true, JSON.stringify(r));
        assert.strictEqual(r._meta['countinghouse/code'], 'MODULE_ASSEMBLY_FAIL', JSON.stringify(r));
        assert.match(JSON.stringify(r.content), /layoutService\/ping\/input\/properties\/s\/pattern/);
        const ok = withInput(path.join(home, `load-plain-${id}`), 'load-plain', {type: 'object', properties: {s: {type: 'string', pattern: '^[a-z]+$'}}});
        const loaded = await load(ok, 'load-plain');
        assert.notStrictEqual(loaded.isError, true, `${JSON.stringify(loaded)}\n${io.err.slice(-2000)}`);
        const called = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/call', params: {name: 'load_plain_layoutservice_ping', arguments: {s: 'abc'}}}, 30000);
        assert.deepStrictEqual(called.result.structuredContent, {text: 'pong'}, JSON.stringify(called));
      });

      it('a $ref expansion bomb is refused at load, and the server goes on answering', async () => {
        const defs = {l0: {type: 'string'}};
        for (let i = 1; i <= 12; i++) defs[`l${i}`] = {anyOf: Array.from({length: 10}, () => ({$ref: `#/defs/l${i - 1}`}))};
        const bomb = withInput(path.join(home, `load-bomb-${id}`), 'load-bomb', {$ref: '#/defs/l12'}, {defs});
        const r = await load(bomb, 'load-bomb');
        assert.strictEqual(r.isError, true, JSON.stringify(r));
        assert.strictEqual(r._meta['countinghouse/code'], 'MODULE_ASSEMBLY_FAIL', JSON.stringify(r));
        const listed = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/list'}, 30000);
        assert.ok(Array.isArray(listed.result.tools) && !listed.result.tools.some((t) => /load_bomb/.test(t.name)));
      });

      if (flags[0] === '--workerThread') {
        it('a schema too slow to compile is refused at load (stage schemaCompile), within --validationCompileMs, and the server goes on answering', async () => {
          // 700 bytes of anyOf: under every load-time check, and about 2.5 s to compile
          const defs = {l0: {type: 'object', properties: {a: {type: 'string'}, b: {type: 'integer'}}}};
          for (let i = 1; i <= 7; i++) defs[`l${i}`] = {anyOf: Array.from({length: 3}, () => ({$ref: `#/defs/l${i - 1}`}))};
          const slowCompile = withInput(path.join(home, `load-compile-${id}`), 'load-compile', {$ref: '#/defs/l7'}, {defs});
          const started = Date.now();
          const r = await load(slowCompile, 'load-compile');
          assert.strictEqual(r.isError, true, JSON.stringify(r));
          assert.strictEqual(r._meta['countinghouse/code'], 'MODULE_ASSEMBLY_FAIL', JSON.stringify(r));
          assert.match(JSON.stringify(r.content), /stage=schemaCompile/);
          assert.ok(Date.now() - started < 10000, `${Date.now() - started} ms`);
          const listed = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/list'}, 30000);
          assert.ok(Array.isArray(listed.result.tools) && !listed.result.tools.some((t) => /load_compile/.test(t.name)));
        });
      }

      it('a module with handlers/ and a main entry loads, and its main entry is never run', async () => {
        const dir = writeModule(path.join(home, `load-both-${id}`), 'load-both', {handlers: true, main: 'device.js'});
        const r = await load(dir, 'load-both');
        assert.notStrictEqual(r.isError, true, `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
        const called = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/call', params: {name: 'load_both_layoutservice_ping', arguments: {}}}, 30000);
        assert.deepStrictEqual(called.result.structuredContent, {text: 'pong'}, JSON.stringify(called));
      });
    });
  });

  // Under enforce: a module's code is in its handler files, which every load
  // requires. One that blocks for good at require time is ended by the block
  // watchdog (maxBlockMs, 10 s by default) with its code, and the runtime
  // stays up (a block during the load is the watchdog's; #144 is the same
  // load under --moduleSandbox off). And a handler that re-exports from a
  // file of its own module (the fixtures' actions.js) resolves inside the
  // module's own namespace.
  describe('the load path under --moduleSandbox enforce', () => {
    let io = null;
    let id = 1;
    const load = async (dir, name, ms = 60000) => {
      const r = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/call', params: {name: 'countinghouse_load_module', arguments: {path: dir, name}}}, ms);
      return r.result;
    };

    before(async () => {
      const run = path.join(home, 'run-enforce');
      fs.mkdirSync(run, {recursive: true});
      const auth = path.join(run, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'module-loading-21', devices: ['*'], admin: true}}));
      io = startStdio(['--workerThread', '--moduleSandbox', 'enforce', '--authoringTools', '--authConfigPath', auth, '--store', 'local', '--storePath', path.join(run, 'store'),
        '--moduleDataPath', path.join(run, 'module_data'), '--modulePath', path.join(run, 'modules')],
      {env: {COUNTINGHOUSE_API_KEY: KEY}});
      await io.request({...INITIALIZE, id: id++}, 60000);
    });
    after(async () => { if (io != null) await io.stop(); });

    it('a handler file that blocks for good at require time: the load fails with the watchdog\'s code, and the runtime stays up', async () => {
      const dir = writeModule(path.join(home, 'load-hangs'), 'load-hangs', {handlers: true});
      fs.writeFileSync(path.join(dir, 'handlers', 'layoutService', 'ping.js'),
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);\nmodule.exports = async () => ({output: {text: 'pong'}});\n");
      const started = Date.now();
      const r = await load(dir, 'load-hangs');
      assert.strictEqual(r.isError, true, JSON.stringify(r));
      assert.strictEqual(r._meta['countinghouse/code'], 'LOAD_MODULE_FAIL', `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
      assert.match(JSON.stringify(r), /worker ended while loading: blocked event loop/);
      assert.ok(Date.now() - started < 15000, `ended within the 10 s block limit (${Date.now() - started} ms)`);
      const listed = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/list'}, 15000);
      assert.ok(Array.isArray(listed.result.tools), 'the runtime still answers');
    });

    it('a handler re-exporting from its own module\'s actions.js loads and answers', async () => {
      const r = await load(path.join(ROOT, 'test', 'fixtures', 'handler-map-module'), 'handler-map-module');
      assert.notStrictEqual(r.isError, true, `${JSON.stringify(r)}\n${io.err.slice(-2000)}`);
      const called = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/call', params: {name: 'handler_map_module_greetservice_hello', arguments: {name: 'x'}}}, 30000);
      assert.strictEqual(called.result.isError, false, JSON.stringify(called));
      assert.strictEqual(called.result.structuredContent.text, 'hello x');
    });
  });

  // Checked before anything is unloaded (reviewer, 2026-11-13): a loaded
  // module whose files change to a main entry with no handlers/ is refused
  // on every way back in -- a load of the same name, POST /reload-module,
  // POST /restart-module -- and the version already loaded keeps serving.
  // HTTP, because /reload-module and /restart-module have no stdio route.
  [
    ['in a worker', 9740, ['--workerThread']],
    ['in single-thread mode', 9741, ['--no-workerThread']]
  ].forEach(([where, port, flags]) => {
    describe(`a reload into the retired layout is refused, and the loaded version keeps serving, ${where}`, () => {
      const {startServer, stopServer, post, waitFor} = require('../helpers/sandbox-server');
      const {deviceIDForName} = require('../../lib/call-address');
      const HTTP_KEY = 'module-loading-21-http';
      const NAME = 'reload-refused';
      const ID = deviceIDForName(NAME);
      let server = null;
      let dir = null;
      const ping = () => post(port, HTTP_KEY, `/devices/${ID}/invoke-action`, {serviceID: 'urn:countinghouse-test:serviceID:layoutService', actionName: 'ping', input: {}});
      const serving = async () => {
        const r = await ping();
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(r.body.output, {text: 'pong'}, JSON.stringify(r.body));
      };
      const refused = (r) => {
        assert.notStrictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.code, 'MODULE_LAYOUT_UNSUPPORTED', JSON.stringify(r.body));
      };

      before(async () => {
        dir = writeModule(path.join(home, `reload-${port}`, NAME), NAME, {handlers: true});
        server = await startServer(port, ['--debug', '--debugKey', HTTP_KEY, ...flags]);
        const loaded = await post(port, HTTP_KEY, '/load-module', {path: dir, name: NAME});
        assert.strictEqual(loaded.status, 200, JSON.stringify(loaded.body));
        await waitFor(async () => (await ping()).status === 200, 20000, `${NAME} to answer`);
        // The files change to the retired layout: a main entry, no handlers/.
        fs.rmSync(path.join(dir, 'handlers'), {recursive: true, force: true});
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: NAME, version: '1.0.0', main: 'device.js'}));
        fs.writeFileSync(path.join(dir, 'device.js'), EXITS);
      });
      after(() => stopServer(server));

      it('a load of the same name', async () => {
        refused(await post(port, HTTP_KEY, '/load-module', {path: dir, name: NAME}));
        await serving();
      });

      it('POST /reload-module', async () => {
        refused(await post(port, HTTP_KEY, '/reload-module', {path: dir}));
        await serving();
      });

      it('POST /restart-module', async () => {
        refused(await post(port, HTTP_KEY, '/restart-module', {path: dir, name: NAME, version: '1.0.0'}));
        await serving();
      });
    });
  });
});
