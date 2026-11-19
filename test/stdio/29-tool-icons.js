'use strict';
// MCP completeness M2 (spec section 4): the load decides an icon. Each icon a
// module declares is read and checked when it loads (lib/declared-icons.js
// inline), and tools/list inlines what was read: never a file read at list
// time. A module whose icon is missing, an SVG, too large or outside it is
// refused, and a reload to such a version leaves the loaded one serving,
// its icon as it was. Over real stdio: packs loaded in place in worker mode
// (as stdio 16), and --loadModule in single-thread mode.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio} = require('../helpers/stdio-client');

const SVC = 'urn:countinghouse-test:serviceID:packService';
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (tag) => Buffer.concat([PNG_HEAD, Buffer.from(tag)]);

// a pack's scenario with one tool, declaring a title, a hint and one icon,
// whose file holds `icon` (a Buffer or text), or is absent (null)
function pack(base, scenario, tool, version, icon) {
  const dir = path.join(base, scenario, version, 'node_modules', scenario);
  fs.mkdirSync(path.join(dir, 'handlers', 'packService'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'icons'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: scenario, version, license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  const file = typeof(icon) === 'string' ? 'icons/tool.svg' : 'icons/tool.png';
  const action = {name: tool, description: `${tool} of ${scenario}`, title: `${tool} ${version}`, annotations: {readOnlyHint: true},
    icons: [{file, sizes: ['16x16']}], input: {schema: `/packService/${tool}/input`}, output: {schema: `/packService/${tool}/output`}};
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: scenario, manufacturer: 'countinghouse-test', modelDescription: scenario,
    serviceList: {[SVC]: {actionList: [action]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    packService: {[tool]: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'packService', `${tool}.js`), `module.exports = async () => ({output: {version: '${version}'}});\n`);
  if (icon != null) fs.writeFileSync(path.join(dir, file), icon);
  return dir;
}

const {dirsOf} = require('../helpers/module-dirs');

describe('stdio 29: an icon is read and checked at load, and listed from what was read (M2)', function() {
  this.timeout(120000);
  const homes = [];
  let io = null;
  afterEach(async () => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
    io = null;
  });
  after(() => { for (const h of homes) fs.rmSync(h, {recursive: true, force: true}); });
  const home = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-29-')); homes.push(h); return h; };
  let id = 10;
  const listed = async (name) => {
    const r = await io.request({jsonrpc: '2.0', id: id++, method: 'tools/list', params: {}}, 60000);
    assert.ok(r.result != null, JSON.stringify(r));
    return r.result.tools.find((t) => t.name === name);
  };
  const dataUri = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;

  it('worker mode: a pack\'s icon is inlined; a reload to a bad icon is refused and the old one is still listed; a good reload lists the new bytes', async () => {
    const h = home();
    const packs = path.join(h, 'packs');
    const base = pack(packs, 'ch-pack-base', 'base_tool', '1.0.0', png('base'));
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(h, 'store'), '--modulePath', path.join(h, 'modules'),
      '--moduleDataPath', path.join(h, 'module_data'), '--controlChannel', 'ipc', '--modulesRoot', packs, '--loadModule', base], {ipc: true});
    const one = await io.control({type: 'load', name: 'ch-pack-icon', dirs: dirsOf(pack(packs, 'ch-pack-icon', 'icon_tool', '1.0.0', png('one')))});
    assert.strictEqual(one.ok, true, `${JSON.stringify(one)}\n${io.err.slice(-2000)}`);
    const v1 = await listed('icon_tool');
    assert.deepStrictEqual(Object.keys(v1), ['name', 'description', 'inputSchema', 'outputSchema', 'title', 'annotations', 'icons']);
    assert.deepStrictEqual([v1.title, v1.annotations, v1.icons], ['icon_tool 1.0.0', {readOnlyHint: true}, [{src: dataUri(png('one')), mimeType: 'image/png', sizes: ['16x16']}]]);

    const svg = await io.control({type: 'reload', names: ['ch-pack-icon'], dirs: dirsOf(pack(packs, 'ch-pack-icon', 'icon_tool', '2.0.0', '<svg xmlns="http://www.w3.org/2000/svg"/>'))});
    assert.strictEqual(svg.ok, false, JSON.stringify(svg));
    assert.match(JSON.stringify(svg), /icons.*SVG is refused/, JSON.stringify(svg));
    const still = await listed('icon_tool');
    assert.deepStrictEqual([still.title, still.icons[0].src], ['icon_tool 1.0.0', dataUri(png('one'))], 'the loaded version, its icon as it was');

    const three = await io.control({type: 'reload', names: ['ch-pack-icon'], dirs: dirsOf(pack(packs, 'ch-pack-icon', 'icon_tool', '3.0.0', png('three')))});
    assert.strictEqual(three.ok, true, `${JSON.stringify(three)}\n${io.err.slice(-2000)}`);
    const v3 = await listed('icon_tool');
    assert.deepStrictEqual([v3.title, v3.icons[0].src], ['icon_tool 3.0.0', dataUri(png('three'))]);
  });

  it('worker mode: a pack whose icon file is missing is refused, naming it, and nothing is listed', async () => {
    const h = home();
    const packs = path.join(h, 'packs');
    const base = pack(packs, 'ch-pack-base', 'base_tool', '1.0.0', png('base'));
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(h, 'store'), '--modulePath', path.join(h, 'modules'),
      '--moduleDataPath', path.join(h, 'module_data'), '--controlChannel', 'ipc', '--modulesRoot', packs, '--loadModule', base], {ipc: true});
    const r = await io.control({type: 'load', name: 'ch-pack-gone', dirs: dirsOf(pack(packs, 'ch-pack-gone', 'gone_tool', '1.0.0', null))});
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(JSON.stringify(r), /icons\/tool\.png.*does not exist/, JSON.stringify(r));
    assert.strictEqual(await listed('gone_tool'), undefined);
    assert.ok((await listed('base_tool')) != null, 'the rest still serves');
  });

  it('single-thread mode: an icon is inlined from the load\'s read, and a module whose icon is an SVG is not loaded', async () => {
    const h = home();
    const packs = path.join(h, 'packs');
    const good = pack(packs, 'ch-pack-good', 'good_tool', '1.0.0', png('good'));
    const bad = pack(packs, 'ch-pack-bad', 'bad_tool', '1.0.0', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    io = startStdio(['--no-workerThread', '--store', 'local', '--storePath', path.join(h, 'store'), '--modulePath', path.join(h, 'modules'),
      '--moduleDataPath', path.join(h, 'module_data'), '--loadModule', good, '--loadModule', bad]);
    const tool = await listed('good_tool');
    assert.ok(tool != null, io.err.slice(-2000));
    assert.deepStrictEqual(tool.icons, [{src: dataUri(png('good')), mimeType: 'image/png', sizes: ['16x16']}]);
    assert.strictEqual(await listed('bad_tool'), undefined);
    assert.match(io.err, /SVG is refused/);
  });
});
