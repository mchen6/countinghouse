'use strict';
// reread on the control channel, spawned (the module-level configuration
// design, sections 4.3 and 7.3; M2a), worker and single-thread mode: ch-local
// has written a module.* value of --settingsFile and sends
// {type: 'reread', what: 'module-settings'}; the next call has the new
// values. A module with any refused value keeps all of its old ones, and the
// reply names what was refused; another module still applies. A required
// setting newly unset leaves the module loaded, and its calls answer
// SETTING_REQUIRED. The local stdio profile: no Redis, no port.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {toolOutput} = require('../helpers/tool-result');

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;

function writeModule(dir, {name, settings, service, action}) {
  fs.mkdirSync(path.join(dir, 'handlers', service), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario', settings}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test',
    modelDescription: name, serviceList: {[SVC(service)]: {actionList: [{name: action, description: `${action} of ${name}`,
      input: {schema: `/${service}/${action}/input`}, output: {schema: `/${service}/${action}/output`}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [service]: {[action]: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', service, `${action}.js`),
    'module.exports = async (input, ctx) => ({output: {settings: Object.assign({}, ctx.settings)}});\n');
  return dir;
}

for (const [mode, thread] of [['worker mode', '--workerThread'], ['single-thread mode', '--no-workerThread']]) {
  describe(`stdio 46: reread of the module settings, ${mode}`, function() {
    this.timeout(120000);
    let home = null;
    let io = null;
    let nextId = 10;
    const settingsFile = () => path.join(home, 'settings.json');
    const write = (values) => fs.writeFileSync(settingsFile(), JSON.stringify({version: 1, values}));
    const call = (name) => io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: {}}}, 60000);
    const toolName = async (suffix) => (await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/list'}, 60000)).result.tools.map((t) => t.name).find((n) => n.endsWith(suffix));
    const settingsOf = async (suffix) => {
      const res = await call(await toolName(suffix));
      return toolOutput(res.result).settings;
    };
    const codeOf = (res) => (res != null && res.result != null && res.result._meta != null) ? res.result._meta['countinghouse/code'] : null;

    before(async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-46-'));
      const nm = path.join(home, 'm', 'node_modules');
      const weather = writeModule(path.join(nm, 'weather-tool'), {name: 'weather-tool', service: 'weatherService', action: 'show',
        settings: {units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'}, maxResults: {type: 'integer', min: 1, max: 100, default: 20}}});
      const region = writeModule(path.join(nm, 'region-tool'), {name: 'region-tool', service: 'regionService', action: 'where',
        settings: {region: {type: 'string', required: true}}});
      write({'module.weather-tool.units': 'imperial', 'module.region-tool.region': 'eu'});
      io = startStdio([thread, '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
        '--moduleDataPath', path.join(home, 'module_data'), '--settingsFile', settingsFile(), '--controlChannel', 'ipc',
        '--loadModule', weather, '--loadModule', region], {ipc: true});
      const init = await io.request(INITIALIZE, 30000);
      assert.ok(init.result != null, JSON.stringify(init));
      io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    });
    after(async () => {
      if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
      if (home != null) fs.rmSync(home, {recursive: true, force: true});
    });

    it('a changed value applies at the next call', async () => {
      assert.deepStrictEqual(await settingsOf('show'), {units: 'imperial', maxResults: 20});
      write({'module.weather-tool.units': 'metric', 'module.weather-tool.maxResults': 50, 'module.region-tool.region': 'eu'});
      const r = await io.control({type: 'reread', what: 'module-settings'});
      assert.deepStrictEqual({ok: r.ok, applied: r.applied, refused: r.refused}, {ok: true, applied: 1, refused: []}, JSON.stringify(r));
      assert.deepStrictEqual(await settingsOf('show'), {units: 'metric', maxResults: 50}, io.err.slice(-1500));
    });

    it('a module with a refused value keeps all of its old values; another module applies', async () => {
      write({'module.weather-tool.units': 'kelvin', 'module.weather-tool.maxResults': 7, 'module.region-tool.region': 'us'});
      const r = await io.control({type: 'reread', what: 'module-settings'});
      assert.deepStrictEqual({ok: r.ok, applied: r.applied, refused: r.refused},
        {ok: true, applied: 1, refused: [{name: 'module.weather-tool.units', code: 'SETTING_INVALID'}]}, JSON.stringify(r));
      assert.deepStrictEqual(await settingsOf('show'), {units: 'metric', maxResults: 50}, 'all of the old values, maxResults too');
      assert.deepStrictEqual(await settingsOf('where'), {region: 'us'});
      const history = fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8');
      assert.match(history, /"setting":"module\.weather-tool\.units"[^\n]*not applied/);
      assert.ok(!/kelvin/.test(io.err), 'the value is never logged');
    });

    it('a required setting newly unset: still loaded, its calls answer SETTING_REQUIRED', async () => {
      write({'module.weather-tool.units': 'metric', 'module.weather-tool.maxResults': 50});
      const r = await io.control({type: 'reread', what: 'module-settings'});
      assert.deepStrictEqual({ok: r.ok, applied: r.applied, refused: r.refused}, {ok: true, applied: 1, refused: []}, JSON.stringify(r));
      const name = await toolName('where');
      assert.ok(name != null, 'still listed');
      assert.strictEqual(codeOf(await call(name)), 'SETTING_REQUIRED');
      write({'module.weather-tool.units': 'metric', 'module.weather-tool.maxResults': 50, 'module.region-tool.region': 'asia'});
      await io.control({type: 'reread', what: 'module-settings'});
      assert.deepStrictEqual(await settingsOf('where'), {region: 'asia'});
    });

    it('a reread of anything else, or a settings file that is not JSON: refused, nothing changed', async () => {
      const other = await io.control({type: 'reread', what: 'everything'});
      assert.deepStrictEqual({ok: other.ok, code: other.code}, {ok: false, code: 'CONTROL_FAILED'});
      fs.writeFileSync(settingsFile(), '{not json');
      const bad = await io.control({type: 'reread', what: 'module-settings'});
      assert.deepStrictEqual({ok: bad.ok, code: bad.code}, {ok: false, code: 'CONTROL_FAILED'});
      assert.deepStrictEqual(await settingsOf('show'), {units: 'metric', maxResults: 50});
    });
  });
}
