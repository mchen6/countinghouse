// A module's error its module says is the caller's (ctx.error's fourth
// argument, {kind: 'caller'}) is recorded as CALLER_ERROR, the caller's, on
// every path that records a call: tools/call answered inline (worker and
// single-thread mode) and a task-augmented call with each job runner, the
// BullMQ one (Redis) and the local one (--store local); tasks run in worker
// mode only. The default is
// the module's (MODULE_ERROR); a kind a module may not choose ('runtime')
// is ignored; a catalogue code is the runtime's MODULE_CODE_RESERVED,
// whatever kind its module named. (HTTP invoke-action records no usage.)
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {startServer, stopServer, waitFor} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');

const KEY = 'caller-kind-key';
const SVC = 'probeService';
const TOOL = (action) => `kind_probe_probeservice_${action.toLowerCase()}`;
const HANDLERS = {
  badInput: "module.exports = async (input, ctx) => { throw ctx.error('KIND_PROBE_BAD_INPUT', 'no such row', null, {kind: 'caller'}); };\n",
  ownFault: "module.exports = async (input, ctx) => { throw ctx.error('KIND_PROBE_BROKEN', 'its own fault'); };\n",
  runtimeKind: "module.exports = async (input, ctx) => { throw ctx.error('KIND_PROBE_CLAIMED', 'not mine to say', null, {kind: 'runtime'}); };\n",
  catalogueKind: "module.exports = async (input, ctx) => { throw ctx.error('ARGUMENTS_INVALID', 'a catalogue code', null, {kind: 'caller'}); };\n"
};
const EXPECTED = {badInput: 'CALLER_ERROR', ownFault: 'MODULE_ERROR', runtimeKind: 'MODULE_ERROR', catalogueKind: 'MODULE_CODE_RESERVED'};

function writeModule(dir) {
  const mod = path.join(dir, 'kind-probe');
  fs.mkdirSync(path.join(mod, 'handlers', SVC), {recursive: true});
  fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({name: 'kind-probe', version: '1.0.0', license: 'Apache-2.0'}));
  const actions = Object.keys(HANDLERS);
  fs.writeFileSync(path.join(mod, 'api.json'), JSON.stringify({device: {friendlyName: 'kind-probe', manufacturer: 'countinghouse-test', modelDescription: 'errors of each kind',
    serviceList: {[`urn:countinghouse-test:serviceID:${SVC}`]: {actionList: actions.map((name) => ({name, description: `Fails: ${name}.`,
      input: {schema: `/${SVC}/${name}/input`}, output: {schema: `/${SVC}/${name}/output`}}))}}}}));
  fs.writeFileSync(path.join(mod, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [SVC]: Object.fromEntries(actions.map((name) => [name, {input: {type: 'object'}, output: {type: 'object'}}]))}));
  for (const [name, code] of Object.entries(HANDLERS)) fs.writeFileSync(path.join(mod, 'handlers', SVC, `${name}.js`), code);
  return mod;
}

// every Out record of the usage directory, as written
function records(usageDir) {
  const out = [];
  for (const day of fs.existsSync(usageDir) ? fs.readdirSync(usageDir) : []) {
    const at = path.join(usageDir, day);
    if (!fs.statSync(at).isDirectory()) continue;
    for (const file of fs.readdirSync(at)) {
      for (const line of fs.readFileSync(path.join(at, file), 'utf8').split('\n')) {
        if (line === '') continue;
        const r = JSON.parse(line);
        if (r.outcome != null && r.server == null) out.push(r);
      }
    }
  }
  return out;
}

const VARIANTS = [
  {name: 'worker mode, the BullMQ runner', port: testPort(9800), flags: ['--workerThread'], tasks: true},
  {name: 'worker mode, the local runner', port: testPort(9801), flags: ['--workerThread', '--store', 'local'], local: true, tasks: true},
  {name: 'single-thread mode', port: testPort(9802), flags: ['--no-workerThread', '--store', 'local'], local: true, tasks: false}
];

for (const variant of VARIANTS) {
  describe(`usage 24: a module's caller-kind error is recorded as the caller's (${variant.name})`, function() {
    this.timeout(120000);
    let server, dir, usageDir;
    const mcp = (method, params) => request(`http://127.0.0.1:${variant.port}`).post('/mcp').set('X-CH-Key', KEY)
      .set('Accept', 'application/json, text/event-stream').send({jsonrpc: '2.0', id: Date.now(), method, params}).then((r) => r.body);

    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-24-'));
      usageDir = path.join(dir, 'usage');
      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'k', devices: ['*']}}));
      const store = variant.local ? ['--storePath', path.join(dir, 'store')] : [];
      server = await startServer(variant.port, variant.flags.concat(store, ['--moduleDataPath', path.join(dir, 'module_data'), '--authConfigPath', auth,
        '--usageDir', usageDir, '--loadModule', writeModule(dir)]));
      await waitFor(async () => {
        const listed = await mcp('tools/list', {});
        return listed.result != null && listed.result.tools.some((t) => t.name === TOOL('badInput'));
      }, 30000, 'kind-probe to be listed');
    });
    after(() => {
      stopServer(server);
      fs.rmSync(dir, {recursive: true, force: true});
    });

    it('tools/call answered inline: each kind\'s code, the answer itself unchanged', async () => {
      for (const action of Object.keys(HANDLERS)) {
        const r = (await mcp('tools/call', {name: TOOL(action), arguments: {}})).result;
        assert.strictEqual(r.isError, true, JSON.stringify(r));
        // nothing new on the wire: the kind is the usage record's only
        assert.deepStrictEqual(Object.keys(r._meta), ['countinghouse/code'], JSON.stringify(r));
      }
      await waitFor(async () => Object.keys(HANDLERS).every((a) => records(usageDir).some((r) => r.tool === TOOL(a))), 10000, 'the Out records');
      for (const [action, code] of Object.entries(EXPECTED)) {
        const got = records(usageDir).filter((r) => r.tool === TOOL(action));
        assert.deepStrictEqual(got.map((r) => r.code), [code], `${action}: ${JSON.stringify(got)}`);
      }
    });

    (variant.tasks ? it : it.skip)('a task-augmented call: the same, from the job runner\'s completion', async () => {
      const before = records(usageDir).length;
      for (const action of ['badInput', 'ownFault']) {
        const created = await mcp('tools/call', {name: TOOL(action), arguments: {}, task: {}});
        assert.ok(created.result && created.result.task, JSON.stringify(created));
        const taskId = created.result.task.taskId;
        await waitFor(async () => ['completed', 'failed'].includes((await mcp('tasks/get', {taskId})).result.status), 20000, `task ${taskId} to settle`);
      }
      await waitFor(async () => records(usageDir).length >= before + 2, 10000, 'the tasks\' Out records');
      const tasks = records(usageDir).slice(before);
      assert.deepStrictEqual(tasks.map((r) => [r.tool, r.code]).sort(), [[TOOL('badInput'), 'CALLER_ERROR'], [TOOL('ownFault'), 'MODULE_ERROR']], JSON.stringify(tasks));
    });

    it('the usage report counts CALLER_ERROR among the errors by code', async () => {
      const r = (await mcp('tools/call', {name: 'countinghouse_usage_report', arguments: {}})).result;
      assert.strictEqual(r.isError, false, JSON.stringify(r).slice(0, 800));
      const codes = JSON.stringify(r.structuredContent);
      // the inline calls, and the tasks' where they ran
      assert.match(codes, new RegExp(`"CALLER_ERROR":${variant.tasks ? 2 : 1}\\b`), codes.slice(0, 1500));
      assert.match(codes, new RegExp(`"MODULE_ERROR":${variant.tasks ? 3 : 2}\\b`), codes.slice(0, 1500));
    });
  });
}
