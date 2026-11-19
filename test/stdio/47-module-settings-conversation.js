'use strict';
// Module settings in conversation, spawned (the module-level configuration
// design, section 4.4; M2b): countinghouse_settings lists a loaded module's
// declared settings (get), changes an enum on request (set), and the
// module's next call has the new value (applied at once, no ch-local); a
// string setting ends at the terminal (no tested client), naming the
// command and never the value. Worker mode (module settings run only with
// worker threads). The local stdio profile: no Redis, no port.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {toolOutput} = require('../helpers/tool-result');

const SVC = 'urn:countinghouse-test:serviceID:weatherService';

function moduleAt(dir) {
  fs.mkdirSync(path.join(dir, 'handlers', 'weatherService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'weather-tool', version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario',
    settings: {units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric', title: 'Units'}, defaultRepo: {type: 'string', format: 'repo'}}}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'weather-tool', manufacturer: 'countinghouse-test', modelDescription: 'weather-tool',
    serviceList: {[SVC]: {actionList: [{name: 'show', description: 'show the settings', input: {schema: '/weatherService/show/input'}, output: {schema: '/weatherService/show/output'}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    weatherService: {show: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'weatherService', 'show.js'), 'module.exports = async (input, ctx) => ({output: {settings: Object.assign({}, ctx.settings)}});\n');
  return dir;
}

describe('stdio 47: module settings in conversation, spawned', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  let nextId = 10;
  const call = (name, args) => io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: args}}, 60000);
  const settingsCall = async (args) => {
    const res = await call('countinghouse_settings', args);
    return res.result;
  };
  const show = async () => {
    const list = (await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/list'}, 60000)).result.tools.map((t) => t.name);
    const name = list.find((n) => n === 'show' || n.endsWith('show'));
    return toolOutput((await call(name, {})).result).settings;
  };

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-47-'));
    const weather = moduleAt(path.join(home, 'm', 'weather-tool'));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {}}));
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--settingsFile', path.join(home, 'settings.json'), '--loadModule', weather]);
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(init.result != null, JSON.stringify(init));
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
  });
  after(async () => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  it('get lists the module\'s settings; an enum set on request applies at the next call', async () => {
    // the module's own call first: its tools/list waits for the startup load
    // (a built-in's call does not), so get finds the module loaded
    assert.deepStrictEqual(await show(), {units: 'metric'});
    const got = toolOutput(await settingsCall({action: 'get'}));
    const rows = got.settings.filter((s) => s.name.startsWith('module.'));
    assert.deepStrictEqual(rows.map((r) => r.name).sort(), ['module.weather-tool.defaultRepo', 'module.weather-tool.units'], JSON.stringify(got).slice(0, 600));
    assert.strictEqual(rows.find((r) => r.name === 'module.weather-tool.units').changes, 'on request');
    const set = await settingsCall({action: 'set', name: 'module.weather-tool.units', value: 'imperial'});
    assert.notStrictEqual(set.isError, true, JSON.stringify(set));
    assert.deepStrictEqual(await show(), {units: 'imperial'}, io.err.slice(-1500));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).values['module.weather-tool.units'], 'imperial');
  });

  it('a string setting ends at the terminal: the command named, never the value', async () => {
    const res = await settingsCall({action: 'set', name: 'module.weather-tool.defaultRepo', value: 'acme/secret-repo'});
    assert.strictEqual(res.isError, true, JSON.stringify(res));
    const text = res.content.map((c) => c.text).join(' ');
    assert.match(text, /ch-local settings set weather-tool\.defaultRepo/);
    assert.ok(!text.includes('acme/secret-repo'), text);
    assert.deepStrictEqual(await show(), {units: 'imperial'});
  });
});
