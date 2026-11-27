// M4 Task 2 (module-level configuration, #413 rev 3, sections 7.1-7.3 and
// 8), server-free: a module-form control message (a top-level module named
// by its package name, with `dirs`, the directory of each module of its
// closure) is read and checked before anything loads; its closure is found
// only among the directories given; the operator's ceiling binds it by each
// module's package name.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {realPath} = require('../helpers/real-path');

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;
function writeModule(dir, {name, version = '1.0.0', role, calls, service = 'svc', friendly}) {
  fs.mkdirSync(path.join(dir, 'handlers', service), {recursive: true});
  const ch = {};
  if (role != null) ch.role = role;
  if (calls != null) ch.calls = calls;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version, countinghouse: ch}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: friendly || name.replace(/^@[^/]+\//, ''), manufacturer: 't', modelDescription: name,
    serviceList: {[SVC(service)]: {actionList: [{name: 'run', description: `run of ${name}`, input: {schema: `/${service}/run/input`}, output: {schema: `/${service}/run/output`}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({[service]: {run: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', service, 'run.js'), 'module.exports = async () => ({output: {}});\n');
  return dir;
}

// (its hooks and cases write modules to disk: a slow Windows runner took
// the before hook over mocha's 2 s default, master's run 46040609989; each
// ends with its own work, 30 s at most)
describe('stdio 38: modules in place, server-free (M4 Task 2)', function() {
  this.timeout(30000);
  const cli = require('../../lib/cli-options');
  const settingsTool = require('../../lib/settings-tool');
  let mip = null;
  let root = null;
  let outside = null;
  let dirs = null;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-38-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-38o-'));
    const store = path.join(root, 'module-store');
    dirs = {
      scenario: writeModule(path.join(store, '@t', 'ch-pack-a', '1.0.0'), {name: '@t/ch-pack-a', role: 'scenario', calls: ['ch-step-s/svc.run']}),
      part: writeModule(path.join(store, '@t', 'ch-step-s', '1.0.0'), {name: '@t/ch-step-s', role: 'part'}),
      out: writeModule(path.join(outside, 'ch-step-s'), {name: '@t/ch-step-s', role: 'part'})
    };
    cli.setOptions({workerThread: true, modulesRoot: [store]});
    mip = require('../../lib/modules-in-place');
  });
  after(() => {
    cli.setOptions({workerThread: false});
    settingsTool.ceilingForControl(() => ({state: 'none'}));
    fs.rmSync(root, {recursive: true, force: true});
    fs.rmSync(outside, {recursive: true, force: true});
  });
  const msg = (extra) => Object.assign({type: 'load', name: '@t/ch-pack-a', dirs: {'@t/ch-pack-a': dirs.scenario, '@t/ch-step-s': dirs.part}}, extra);
  // its shape as the load handler checks it (lib/module-control.js, once),
  // then what the request reads from disk
  const readAsLoaded = (m) => {
    const problem = mip.moduleMessageProblem('load', m);
    if (problem != null) throw Object.assign(new Error(problem.message), {code: 'CONTROL_FAILED'});
    return mip.readModuleRequest(m, {needsDirs: true});
  };
  const refusedWith = (m, re) => assert.throws(() => readAsLoaded(m), (e) => e.code === 'CONTROL_FAILED' && re.test(e.message), JSON.stringify(m).slice(0, 200));

  it('a well-formed message is read: its name, and each directory by its real path', () => {
    const r = mip.readModuleRequest(msg(), {needsDirs: true});
    assert.strictEqual(r.name, '@t/ch-pack-a');
    assert.strictEqual(r.dirs.get('@t/ch-step-s'), realPath(dirs.part));
  });

  it('refuses a name that is not a package name, and an old-form field beside the module form', () => {
    refusedWith(msg({name: 'Bad Name'}), /package name/);
    for (const field of ['scenario', 'pack', 'global', 'remoteCredentials']) refusedWith(msg({[field]: 'x'}), /no scenario, pack, global or remoteCredentials/);
  });

  it('refuses dirs that are not absolute, outside --modulesRoot, of another package, the same directory twice, or not naming the module itself', () => {
    refusedWith(msg({dirs: {'@t/ch-pack-a': 'relative/dir'}}), /absolute/);
    refusedWith(msg({dirs: {'@t/ch-pack-a': dirs.scenario, '@t/ch-step-s': dirs.out}}), /outside --modulesRoot/);
    refusedWith(msg({dirs: {'@t/ch-pack-a': dirs.scenario, '@t/ch-step-x': dirs.part}}), /the package at .* is @t\/ch-step-s/);
    refusedWith(msg({dirs: {'@t/ch-pack-a': dirs.scenario, '@t/ch-step-s': dirs.part, '@t/ch-step-t': dirs.part}}), /same directory|the package at/);
    refusedWith(msg({dirs: {'@t/ch-step-s': dirs.part}}), /names no directory for @t\/ch-pack-a/);
    refusedWith(msg({dirs: {}}), /dirs/);
  });

  it('refuses a message on a runtime given no --modulesRoot', () => {
    cli.setOptions({workerThread: true, modulesRoot: []});
    try {
      refusedWith(msg(), /no --modulesRoot/);
    } finally {
      cli.setOptions({workerThread: true, modulesRoot: [path.join(root, 'module-store')]});
    }
  });

  it('the closure is found only among the directories given: a part in a node_modules beside the scenario is not, PART_MISSING', () => {
    const planted = writeModule(path.join(dirs.scenario, 'node_modules', '@t', 'ch-step-s'), {name: '@t/ch-step-s', role: 'part'});
    try {
      const r = mip.readModuleRequest(msg({dirs: {'@t/ch-pack-a': dirs.scenario}}), {needsDirs: true});
      assert.throws(() => mip.closureOf(r), (e) => e.code === 'PART_MISSING', 'found the planted part');
      const full = mip.readModuleRequest(msg(), {needsDirs: true});
      assert.deepStrictEqual([...mip.closureOf(full).keys()].sort(), ['@t/ch-pack-a', '@t/ch-step-s']);
    } finally {
      fs.rmSync(path.join(dirs.scenario, 'node_modules'), {recursive: true, force: true});
    }
  });

  // the medium review of M4a, finding 10: a part is found by friendly name
  // among the directories given; two of them under one name are refused
  it('resolvePart given a list of directories looks only among them (medium 9)', () => {
    const roles = require('../../lib/module-roles');
    assert.strictEqual(roles.resolvePart('ch-step-s', dirs.scenario, [dirs.part]), dirs.part);
    assert.strictEqual(roles.resolvePart('ch-step-s', dirs.scenario, []), null);
  });

  it('two directories whose modules share a friendly name are refused', () => {
    const twin = writeModule(path.join(root, 'module-store', '@u', 'ch-step-s', '1.0.0'), {name: '@u/ch-step-s', role: 'part', friendly: 'ch-step-s'});
    refusedWith(msg({dirs: {'@t/ch-pack-a': dirs.scenario, '@t/ch-step-s': dirs.part, '@u/ch-step-s': twin}}), /friendly name ch-step-s/);
  });

  it('a directory the closure does not hold is refused: the message says exactly what loads', () => {
    const extra = writeModule(path.join(root, 'module-store', '@t', 'ch-step-x', '1.0.0'), {name: '@t/ch-step-x', role: 'part'});
    const r = mip.readModuleRequest(msg({dirs: {'@t/ch-pack-a': dirs.scenario, '@t/ch-step-s': dirs.part, '@t/ch-step-x': extra}}), {needsDirs: true});
    assert.throws(() => mip.closureOf(r), (e) => e.code === 'CONTROL_FAILED' && /@t\/ch-step-x is not in the closure/.test(e.message));
  });

  // #427's high review, 4: what loads is checked again by its resolved path
  it('a directory resolved outside --modulesRoot after it was read (a link swapped in between) is refused', () => {
    const r = mip.readModuleRequest(msg(), {needsDirs: true});
    r.dirs.set('@t/ch-step-s', realPath(dirs.out));
    assert.throws(() => mip.closureOf(r), (e) => e.code === 'CONTROL_FAILED' && /outside --modulesRoot/.test(e.message));
  });

  it('a link out of --modulesRoot inside a module\'s directory is refused', () => {
    const link = path.join(dirs.part, 'handlers', 'escape.js');
    fs.symlinkSync(path.join(outside, 'ch-step-s', 'package.json'), link);
    try {
      const r = mip.readModuleRequest(msg(), {needsDirs: true});
      assert.throws(() => mip.closureOf(r), (e) => e.code === 'CONTROL_FAILED' && /link outside --modulesRoot/.test(e.message));
    } finally {
      fs.unlinkSync(link);
    }
  });

  // the back-sweep (the Reviewer, 11-18): confinement decides on the
  // kernel's real path (#10). Node's JS realpath resolves this chain to the
  // module's own directory at every step; a POSIX kernel walks one level up
  // per link, so the fifth is --modulesRoot's parent. Windows normalises
  // '..' in a reparse point's target lexically, so there the chain stays
  // inside and nothing escapes: POSIX only (the Reviewer's high review of
  // #441, 2).
  (process.platform === 'win32' ? it.skip : it)('a link chain the kernel resolves out of --modulesRoot (x -> ".", a -> "x/..", b -> "a/..", ...) is refused, though JS realpath puts it inside (POSIX)', () => {
    const chain = [['x', '.'], ['a', 'x/..'], ['b', 'a/..'], ['c', 'b/..'], ['d', 'c/..']];
    for (const [n, target] of chain) fs.symlinkSync(target, path.join(dirs.part, n));
    try {
      const d = path.join(dirs.part, 'd');
      assert.strictEqual(fs.realpathSync(d), fs.realpathSync(dirs.part), 'JS realpath: inside the module');
      assert.strictEqual(realPath(d), path.dirname(realPath(path.join(root, 'module-store'))), 'the kernel: --modulesRoot\'s parent');
      const r = mip.readModuleRequest(msg(), {needsDirs: true});
      assert.throws(() => mip.closureOf(r), (e) => e.code === 'CONTROL_FAILED' && /link outside --modulesRoot \(d\)/.test(e.message));
    } finally {
      for (const [n] of chain) fs.unlinkSync(path.join(dirs.part, n));
    }
  });

  describe('credentials in a load message (section 7.3)', () => {
    const credentials = require('../../lib/remote/credentials');
    const ORIGIN = 'https://api.example.com';
    let saved = null;
    before(() => {
      saved = credentials.snapshot();
      const file = path.join(root, 'allow.json');
      fs.writeFileSync(file, JSON.stringify({version: 2, modules: {'@t/ch-step-s': {[ORIGIN]: {API_KEY: 'COUNTINGHOUSE_CREDENTIAL_1'}}}}));
      credentials.configure(file);
    });
    after(() => credentials.restore(saved));

    it('taken as the module\'s allowance when it repeats the start\'s file', () => {
      const r = mip.readModuleRequest(msg({credentials: {'@t/ch-step-s': {[ORIGIN]: {API_KEY: 'COUNTINGHOUSE_CREDENTIAL_1'}}}}), {needsDirs: true});
      assert.strictEqual(r.credentials.get('@t/ch-step-s').get(ORIGIN).get('API_KEY'), 'COUNTINGHOUSE_CREDENTIAL_1');
    });

    it('refused: an environment name that is not a slot, a slot the start did not name, a module not in dirs', () => {
      refusedWith(msg({credentials: {'@t/ch-step-s': {[ORIGIN]: {API_KEY: 'PATH'}}}}), /slot/);
      refusedWith(msg({credentials: {'@t/ch-step-s': {[ORIGIN]: {API_KEY: 'COUNTINGHOUSE_CREDENTIAL_2'}}}}), /not named by the start's file/);
      refusedWith(msg({credentials: {'@t/ch-step-x': {[ORIGIN]: {API_KEY: 'COUNTINGHOUSE_CREDENTIAL_1'}}}}), /which dirs does not/);
      refusedWith(msg({credentials: []}), /credentials is an object/);
    });
  });

  describe('the ceiling, by each module\'s package name (section 8)', () => {
    const trusted = (ceiling) => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: Object.assign({}, ceiling)});
    const names = ['@t/ch-pack-a', '@t/ch-step-s'];

    it('none, or a trusted one with no list: allowed', () => {
      settingsTool.ceilingForControl(() => ({state: 'none'}));
      assert.strictEqual(mip.moduleCeilingRefusal(names), null);
      settingsTool.ceilingForControl(() => trusted({}));
      assert.strictEqual(mip.moduleCeilingRefusal(names), null);
    });

    it('a trusted modules list: every module of the closure must be on it; one that is not is named, as enabled.<module>', () => {
      settingsTool.ceilingForControl(() => trusted({modules: names}));
      assert.strictEqual(mip.moduleCeilingRefusal(names), null);
      settingsTool.ceilingForControl(() => trusted({modules: ['@t/ch-pack-a']}));
      const r = mip.moduleCeilingRefusal(names);
      assert.strictEqual(r.code, 'SETTING_FORBIDDEN_BY_CEILING');
      assert.match(r.message, /enabled\.@t\/ch-step-s/);
    });

    // M6 (#413 rev 3 section 8): a ceiling that still holds packs is not
    // trusted at all (lib/settings-ceiling.js), so a module-form load is
    // refused, saying why
    it('a ceiling that still holds packs refuses a module-form load (fail closed), saying to list modules', () => {
      const {parse} = require('../../lib/settings-ceiling');
      const read = parse('{"version": 1, "packs": ["a"]}');
      settingsTool.ceilingForControl(() => ({state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: read.problem}));
      const r = mip.moduleCeilingRefusal(names);
      assert.strictEqual(r.code, 'SETTING_CEILING_UNTRUSTED');
      assert.match(r.message, /it holds "packs", which is no longer read: list each module under "modules"/);
    });

    it('an untrusted ceiling refuses', () => {
      settingsTool.ceilingForControl(() => ({state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'writable by others'}));
      assert.strictEqual(mip.moduleCeilingRefusal(names).code, 'SETTING_CEILING_UNTRUSTED');
    });
  });
});
