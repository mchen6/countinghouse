'use strict';
// C-startup-order (the high on #419): the startup list's modules load several
// at once, and each pins the device IDs its friendlyName derives at its
// spawn. Two on the list with one friendlyName: the first in the list wins
// its device, as a one-at-a-time start gave; the later one is refused
// (DEVICE_OBJECT_CONFLICT) -- never both. A real server start, two loads at
// once (COUNTINGHOUSE_TEST_STARTUP_LIMIT, read under the test flag).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, waitFor} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const tmp = require('../helpers/test-tmp').forFile(['startup-twins-']);

const KEY = 'aabbcc';
const PORT = testPort(9815);
const TOOL = 'handler_map_module_greetservice_hello';

// a copy of handler-map-module under its own package name, the same
// friendlyName, answering with the name it was given
function twin(base, name) {
  const dir = path.join(base, name);
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'handler-map-module'), dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0'}));
  fs.writeFileSync(path.join(dir, 'actions.js'),
    `module.exports = {greetService: {hello: (input, ctx, callback) => callback(null, {output: {text: ${JSON.stringify(name)}, caller: ctx.caller.id}})}};\n`);
  return dir;
}

describe('module-loading 45: two startup modules with one friendlyName -- the first in the list wins (C-startup-order)', function() {
  this.timeout(120000);
  let server = null;
  after(() => stopServer(server));

  it('loaded several at once, the first in the list keeps its device; the later one is refused', async () => {
    const base = tmp.mkdtemp('startup-twins-');
    // (twin-first takes about 3 s to load -- slow-load-module's handler, the
    // twins' friendlyName -- so twin-second has spawned and pinned the ID
    // well before twin-first registers, every run)
    const first = path.join(base, 'twin-first');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'slow-load-module'), first, {recursive: true});
    fs.writeFileSync(path.join(first, 'package.json'), JSON.stringify({name: 'twin-first', version: '1.0.0'}));
    const api = JSON.parse(fs.readFileSync(path.join(first, 'api.json'), 'utf8'));
    api.device.friendlyName = 'handler-map-module';
    fs.writeFileSync(path.join(first, 'api.json'), JSON.stringify(api));
    const second = twin(base, 'twin-second');
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--store', 'local', '--storePath', path.join(base, 'store'),
      '--loadModule', first, '--loadModule', second], {env: {COUNTINGHOUSE_TEST_STARTUP_LIMIT: '2'}});
    // (once discovery is over: both have had their turn)
    await waitFor(() => server.output.includes('all module discovered'), 60000, 'discovery over');
    // (the device is twin-first's: its slowService answers, twin-second's
    // greetService is no tool)
    const r = await mcpCall(PORT, KEY, 'handler_map_module_slowservice_ping', {}, {allowUnknownTool: true});
    assert.strictEqual(r.isError, false, `${JSON.stringify(r)}\n${server.output.slice(-3000)}`);
    assert.strictEqual((await mcpCall(PORT, KEY, TOOL, {name: 'x'}, {allowUnknownTool: true})).code, -32602, 'twin-second\'s tool is none');
    assert.match(server.output, /module twin-second's device [^ ]+ is module twin-first's -- refused/);
    assert.doesNotMatch(server.output, /module twin-first's device [^ ]+ is module twin-second's/);
  });

  tmp.hooks();
});

// The rule itself, at registration (lib/device-manager.js registerFromSpec),
// as the start's timing can't be forced through a server: in its startup turn
// a module's declaration comes first against one pinned by a module later in
// the list or not on it (a load in place meanwhile); a module before it still
// counts; outside a startup turn, as before.
describe('module-loading 45: registration in a startup turn (C-startup-order, the rule)', () => {
  const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
  let keptOptions = null;
  let DeviceManager = null;
  let WorkerMessage = null;
  let moduleSpec = null;
  let ModuleManager = null;
  before(() => {
    keptOptions = optionsNow();
    require('../../lib/cli-options').setOptions({workerThread: false});
    require('../../lib/logger').createLogger();
    DeviceManager = require('../../lib/device-manager');
    WorkerMessage = require('../../lib/worker-message');
    moduleSpec = require('../../lib/module-spec');
    ModuleManager = require('../../lib/module-manager');
  });
  after(() => { restoreOptions(keptOptions); });

  // modules named, each with one friendlyName's device pinned, as their spawns pin it
  async function world(names) {
    const wms = {};
    const pinned = {};
    for (const name of names) {
      const wm = new WorkerMessage(null);
      wm.moduleSpec = await moduleSpec.fromParts({device: {friendlyName: 'one-name', manufacturer: 'countinghouse-test', modelDescription: 'module-loading 45', serviceList: {}}}, null);
      wm.hostModuleName = name;
      wm.hostModulePath = `/modules/${name}`;
      wm.hostPackageInfo = {name};
      wms[name] = wm;
      pinned[name] = new Set([wm.moduleSpec.deviceID]);
    }
    const mm = {on: () => {}, modules: wms, pinnedDeviceIDs: pinned, startupRanks: null, startupEarlier: ModuleManager.prototype.startupEarlier};
    return {dm: new DeviceManager(mm), wms, mm};
  }
  // the start's discovery under way with this startup list
  const during = (mm, list) => { mm.startupRanks = new Map(list.map((n, i) => [n, i])); };

  it('a load in place meanwhile is refused; the startup module, in its turn, keeps its device', async () => {
    const {dm, wms, mm} = await world(['slow-first', 'twin-in-place']);
    during(mm, ['slow-first', 'filler']);
    assert.strictEqual(dm.registerFromSpec(wms['twin-in-place']), false, 'the load in place: slow-first pinned it');
    assert.strictEqual(dm.registerFromSpec(wms['slow-first']), true, 'slow-first in its turn');
  });

  it('two on the list: the earlier in its turn keeps it, the later is refused', async () => {
    const list = ['twin-first', 'twin-second'];
    const {dm, wms, mm} = await world(list);
    during(mm, list);
    // (in either order: twin-second first is refused, twin-first -- in its
    // turn, or restarted before the start's discovery ends -- keeps it)
    assert.strictEqual(dm.registerFromSpec(wms['twin-second']), false);
    assert.strictEqual(dm.registerFromSpec(wms['twin-first']), true);
    assert.strictEqual(dm.registerFromSpec(wms['twin-second']), false);
  });

  it('a module before it on the list still counts (a load that failed keeps its pin)', async () => {
    const list = ['failed-first', 'later'];
    const {dm, wms, mm} = await world(list);
    during(mm, list);
    assert.strictEqual(dm.registerFromSpec(wms.later), false);
  });

  it('outside the start\'s discovery, as before: any other module\'s pin refuses it', async () => {
    const {dm, wms} = await world(['a', 'b']);
    assert.strictEqual(dm.registerFromSpec(wms.a), false);
  });

  it('the pinned index names the earliest holder while the start\'s discovery lasts, the last spawner after', () => {
    const mm = Object.create(ModuleManager.prototype);
    mm.startupRanks = new Map([['a', 0], ['b', 1]]);
    assert.strictEqual(mm.startupEarlier('a', 'b'), true);
    assert.strictEqual(mm.startupEarlier('b', 'a'), false);
    assert.strictEqual(mm.startupEarlier('a', 'elsewhere'), true, 'a load in place');
    assert.strictEqual(mm.startupEarlier('elsewhere', 'a'), false);
    mm.startupRanks = null;
    assert.strictEqual(mm.startupEarlier('a', 'b'), false, 'after discovery: no order');
  });
});
