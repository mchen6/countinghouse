'use strict';
// A module turned off in conversation on a shared runtime (R-terminal-only-shared-text):
// written at once, with no form; ch-local's unload then takes it from every
// session, each told once, with the one way back (runtime-claims 1). Turned on
// is the user's own terminal's, from a client that declares form elicitation
// too. Spawned as ch-local daemon spawns the runtime, with production's
// tested-client list (a client listed there would be asked: move the case).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {until, runtime, listening, request, shim} = require('./helpers/per-session');
// (under os.tmpdir(): the socket's path is short there)
const trees = require('../helpers/test-tmp').forFile(['ch-sr17-'], {base: os.tmpdir()});
const PKG = '@acme/off-tool';
const OTHER = '@acme/other-tool';

// one tool, <short>_run
function writeModule(root, name) {
  const short = name.slice('@acme/'.length);
  const dir = path.join(root, '@acme', short, '1.0.0');
  const svc = 'runService';
  const tool = `${short.replace('-', '_')}_run`;
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: short, manufacturer: 'countinghouse-test', modelDescription: 'turned off',
    serviceList: {[`urn:x:serviceID:${svc}`]: {actionList: [{name: tool, description: 'runs', input: {schema: `/${svc}/${tool}/input`}, output: {schema: `/${svc}/${tool}/output`}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [svc]: {[tool]: {input: {type: 'object'}, output: {type: 'object', properties: {ok: {type: 'boolean'}}}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', svc, `${tool}.js`), 'module.exports = async () => ({output: {ok: true}});\n');
  return dir;
}

describe('session-runtime 17: a module turned off in conversation on a shared runtime', function() {
  this.timeout(120000);
  if (process.platform === 'win32') return;   // the named pipe is C2's
  let r = null;
  after(async () => {
    if (r != null && r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
  });

  it('off applied for every session, told once with the terminal command; on refused with it; another setting is the terminal\'s', async () => {
    const home = trees.mkdtemp('ch-sr17-');
    const settingsFile = path.join(home, 'settings.json');
    const store = path.join(home, 'module-store');
    const dirs = {[PKG]: writeModule(store, PKG), [OTHER]: writeModule(store, OTHER)};
    fs.writeFileSync(path.join(home, 'modules.json'), JSON.stringify({modules: {[PKG]: {version: '1.0.0', role: 'scenario'}, [OTHER]: {version: '1.0.0', role: 'scenario'}}, packs: {p: {modules: {[PKG]: '1.0.0', [OTHER]: '1.0.0'}}}}));
    r = runtime(home, ['--settingsFile', settingsFile, '--modulesRoot', store]);
    const secret = await listening(r);
    assert.ok(secret != null, r.log().slice(-2000));
    for (const name of [PKG, OTHER]) {
      const loaded = await r.control({type: 'load', name, dirs: {[name]: dirs[name]}});
      assert.strictEqual(loaded.ok, true, `${JSON.stringify(loaded)}: ${r.log().slice(-1500)}`);
    }
    const a = await shim.session(r.socket, secret);
    const b = await shim.session(r.socket, secret);
    assert.ok(a.welcome != null && b.welcome != null);
    const call = (s, args) => request(s.c, 'tools/call', {name: 'countinghouse_settings', arguments: args});
    const listed = async (s) => (await request(s.c, 'tools/list')).result.tools.some((t) => t.name === 'off_tool_run');
    assert.ok(await until(() => listed(a)) && await until(() => listed(b)), r.log().slice(-1500));

    const off = await call(a, {action: 'set', name: `enabled.${PKG}`, value: 'off'});
    assert.notStrictEqual(off.result.isError, true, JSON.stringify(off));
    assert.strictEqual(off.result.structuredContent.new, 'off');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).values, {[`enabled.${PKG}`]: false});
    // (as ch-local's applier takes it: an unload with its reason)
    assert.strictEqual((await r.control({type: 'unload', name: PKG, reason: 'off', notice: `${PKG} turned off`})).ok, true);
    assert.deepStrictEqual([await until(async () => !(await listed(a))), await until(async () => !(await listed(b)))], [true, true]);
    // each session's next result of a module's tool tells it, once
    const other = async (s) => JSON.stringify((await request(s.c, 'tools/call', {name: 'other_tool_run', arguments: {}})).result);
    for (const s of [a, b]) {
      const said = await other(s);
      assert.ok(said.includes(`${PKG} is turned off for all your sessions. It stays off until it is turned on again at a terminal: `), said.slice(0, 1500));
      assert.doesNotMatch(said, /you'll be asked to confirm/);
      assert.doesNotMatch(await other(s), /is turned off for all your sessions/);
    }

    const meta = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {elicitation: {form: {}}}, 'io.modelcontextprotocol/clientInfo': {name: 'claude-code', version: '2.1.330'}};
    const on = await request(b.c, 'tools/call', {name: 'countinghouse_settings', arguments: {action: 'set', name: `enabled.${PKG}`, value: 'on'}, _meta: meta});
    assert.strictEqual(on.result._meta['countinghouse/code'], 'SETTING_NEEDS_CONFIRMATION', JSON.stringify(on));
    const check = await call(b, {action: 'set', name: 'upgradeCheck', value: 'weekly'});
    assert.strictEqual(check.result._meta['countinghouse/code'], 'SETTING_TERMINAL_ONLY_SHARED', JSON.stringify(check));
    assert.match(check.result.content[0].text, /^This shared runtime takes this change to upgradeCheck from a terminal only; nothing was changed\. To make it, run `.*settings set upgradeCheck weekly` in a terminal yourself\.$/);
    a.c.end();
    b.c.end();
  });

  trees.hooks();
});
