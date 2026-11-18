'use strict';
// Module settings at a module's load, spawned (the module-level
// configuration design, sections 4.2 and 4.7):
// - --moduleSettings <file> (an operator's, outside ch-local): a bare flag,
//   one beside --settingsFile, or a file that is not an object of objects
//   stops the start; a required setting it leaves unset refuses that
//   module's load, saying so for the operator; the file is one no module
//   may reach (the file broker's protected paths);
// - --settingsFile (ch-local's): a stored value the loaded version does not
//   accept is not applied, said in the log by name (never the value) and in
//   one history line beside the file.
// The local stdio profile: no Redis, no port.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, spawnSync} = require('child_process');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'bin', 'countinghouse-stdio.js');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'handler-map-convention');

describe('stdio 37: module settings read at a module\'s load', function() {
  this.timeout(60000);
  let home = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-37-')); });
  afterEach(() => fs.rmSync(home, {recursive: true, force: true}));

  const base = () => ['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data')];
  // the fixture, with `settings` declared
  function moduleWith(settings) {
    const dir = path.join(home, 'm');
    fs.cpSync(FIXTURE, dir, {recursive: true});
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.countinghouse = Object.assign({}, pkg.countinghouse, {settings});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return {dir, name: pkg.name};
  }
  const exits = (args) => spawnSync(process.execPath, [ENTRY, ...base(), ...args], {encoding: 'utf8', timeout: 30000, input: ''});
  // the runtime's log until discovery is over (or it exits)
  function logUntilDiscovered(args) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [ENTRY, ...base(), ...args], {stdio: ['pipe', 'pipe', 'pipe']});
      let err = '';
      const done = () => { clearTimeout(timer); child.kill('SIGKILL'); resolve(err); };
      const timer = setTimeout(done, 30000);
      child.stderr.on('data', (d) => { err += d; if (/all module discovered/.test(err)) setTimeout(done, 200); });
      child.on('exit', done);
    });
  }

  it('--moduleSettings with no path, beside --settingsFile, or not an object of objects: the start stops', () => {
    const file = path.join(home, 'ms.json');
    fs.writeFileSync(file, '{}');
    const bare = exits(['--moduleSettings']);
    assert.strictEqual(bare.status, 2, bare.stderr);
    assert.match(bare.stderr, /--moduleSettings needs one path/);
    const both = exits(['--moduleSettings', file, '--settingsFile', path.join(home, 'settings.json')]);
    assert.strictEqual(both.status, 2, both.stderr);
    assert.match(both.stderr, /--moduleSettings/);
    for (const bad of ['{nope', '[]', '{"m": 3}']) {
      fs.writeFileSync(file, bad);
      const r = exits(['--moduleSettings', file]);
      assert.strictEqual(r.status, 2, `${bad}: ${r.stderr}`);
      assert.match(r.stderr, /--moduleSettings/);
    }
  });

  it('--moduleSettings given twice stops the start; an all-digit name is a path', () => {
    const file = path.join(home, 'ms.json');
    fs.writeFileSync(file, '{}');
    const twice = exits(['--moduleSettings', file, '--moduleSettings', file]);
    assert.strictEqual(twice.status, 2, twice.stderr);
    assert.match(twice.stderr, /--moduleSettings needs one path/);
    fs.writeFileSync(path.join(home, '123'), '[]');   // a number for minimist, a file here: read, and refused as not an object
    const numeric = spawnSync(process.execPath, [ENTRY, ...base(), '--moduleSettings', '123'], {encoding: 'utf8', timeout: 30000, input: '', cwd: home});
    assert.strictEqual(numeric.status, 2, numeric.stderr);
    assert.match(numeric.stderr, /--moduleSettings is an object/);
  });

  it('--moduleSettings leaving a required setting unset: the module is not loaded, and the log says why', async () => {
    const m = moduleWith({region: {type: 'string', required: true}});
    const file = path.join(home, 'ms.json');
    fs.writeFileSync(file, JSON.stringify({[m.name]: {}}));
    const log = await logUntilDiscovered(['--moduleSettings', file, '--loadModule', m.dir]);
    assert.match(log, /region/);
    assert.match(log, /unset in --moduleSettings/);
    assert.ok(!new RegExp(`module: ${m.name}@[^ ]+ loaded`).test(log), 'not loaded');
  });

  it('--moduleSettings setting it: the module loads', async () => {
    const m = moduleWith({region: {type: 'string', required: true}});
    const file = path.join(home, 'ms.json');
    fs.writeFileSync(file, JSON.stringify({[m.name]: {region: 'eu'}}));
    const log = await logUntilDiscovered(['--moduleSettings', file, '--loadModule', m.dir]);
    assert.match(log, new RegExp(`module: ${m.name}@[^ ]+ loaded`), log.slice(-2000));
  });

  it('--settingsFile: a stored value the version does not accept is said by name, never by value, and one history line is written', async () => {
    const m = moduleWith({units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric'}});
    const settings = path.join(home, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({version: 1, values: {[`module.${m.name}.units`]: 'kelvin-xyz'}}));
    const io = startStdio([...base(), '--settingsFile', settings, '--loadModule', m.dir]);
    try {
      assert.ok((await io.request(INITIALIZE, 30000)).result != null);
      const end = Date.now() + 20000;
      while (!/not applied/.test(io.err) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      assert.match(io.err, /setting units not applied/);
      assert.ok(!io.err.includes('kelvin-xyz'), 'the value is never logged');
      const lines = fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepStrictEqual(lines.map((l) => [l.setting, l.by]), [[`module.${m.name}.units`, 'runtime']]);
    } finally {
      io.child.kill();
      await io.exited;
    }
  });

  it('the file is one no module may reach (the file broker\'s protected paths)', () => {
    const file = path.join(home, 'ms.json');
    const paths = require('../../lib/fs-broker').protectedPaths({moduleSettings: file, modulePath: home, moduleDataPath: home});
    assert.ok(paths.includes(path.resolve(file)), JSON.stringify(paths));
  });
});
