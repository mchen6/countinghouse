'use strict';
// B-own-runtime: lib/own-module-check.js, what the single-identity
// profile's validate_module reads of a user's own module folder, and never
// beyond it (the own-modules design §2.3; the medium on B-own-runtime).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const check = require('../../lib/own-module-check');
const tmp = require('../helpers/test-tmp').forFile(['ch-mauth-08-'], {base: require('os').tmpdir()});

describe('module-authoring 08: an own module\'s folder, as the profile reads it (B-own-runtime)', function() {
  this.timeout(60000);
  const real = (p) => fs.realpathSync.native(p);
  const mod = (dir) => {
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'my-tool', version: '1.0.0', countinghouse: {role: 'scenario'}}));
    return dir;
  };

  it('inside: a name that merely starts with ".." is inside its root', () => {
    assert.strictEqual(check.inside('/h/.ch/..mine', '/h/.ch'), true);
    assert.strictEqual(check.inside('/h/.ch', '/h/.ch'), true);
    assert.strictEqual(check.inside('/h/other', '/h/.ch'), false);
    assert.strictEqual(check.inside('/h', '/h/.ch'), false);
  });

  // (pinned on every OS with both path flavours: a Windows path's drive is
  // its root, never a part of the way -- C:\\C: was looked up, and every real
  // folder was "not there" on Windows: #499's stdio 51 on windows-latest)
  it('pathsOnTheWay: each folder from below the root to the path, the root itself never a part', () => {
    assert.deepStrictEqual(check.pathsOnTheWay('C:\\Users\\me\\mod', path.win32), ['C:\\Users', 'C:\\Users\\me', 'C:\\Users\\me\\mod']);
    assert.deepStrictEqual(check.pathsOnTheWay('\\\\server\\share\\mod', path.win32), ['\\\\server\\share\\mod']);
    assert.deepStrictEqual(check.pathsOnTheWay('/home/me/mod', path.posix), ['/home', '/home/me', '/home/me/mod']);
    assert.deepStrictEqual(check.pathsOnTheWay('C:\\', path.win32), []);
    assert.deepStrictEqual(check.pathsOnTheWay('/', path.posix), []);
  });

  it('pathRefusal: a folder inside a root, or holding one, is refused; one elsewhere answers its real path', () => {
    const base = real(tmp.mkdtemp('ch-mauth-08-'));
    const home = path.join(base, 'home', '.countinghouse');
    fs.mkdirSync(home, {recursive: true});
    const roots = {home, modulePath: null, moduleDataPath: null, storePath: null};
    const dotted = mod(path.join(home, '..mine'));
    assert.match(check.pathRefusal(dotted, roots).message, /inside the ch-local home/);
    assert.match(check.pathRefusal(path.join(base, 'home'), roots).message, /holds the ch-local home/, 'a parent of the home');
    const mine = mod(path.join(base, 'work', 'mine'));
    assert.deepStrictEqual(check.pathRefusal(mine, roots), {real: mine});
  });

  it('treeProblems: a link or a second name inside blocks the read', () => {
    const base = real(tmp.mkdtemp('ch-mauth-08-'));
    const secret = path.join(base, 'outside.txt');
    fs.writeFileSync(secret, 'sk-not-json');
    const linked = mod(path.join(base, 'linked'));
    fs.symlinkSync(secret, path.join(linked, 'api.json'));
    const l = check.treeProblems(linked);
    assert.strictEqual(l.blocking, true);
    assert.ok(l.problems.some((p) => /link \(api\.json\)/.test(p)), JSON.stringify(l.problems));
    const twice = mod(path.join(base, 'twice'));
    fs.linkSync(secret, path.join(twice, 'api.json'));
    const t = check.treeProblems(twice);
    assert.strictEqual(t.blocking, true);
    assert.ok(t.problems.some((p) => /second name \(api\.json\)/.test(p)), JSON.stringify(t.problems));
    assert.strictEqual(check.treeProblems(mod(path.join(base, 'plain'))).blocking, false);
  });

  it(`treeProblems: more than ${check.MAX_ENTRIES} entries blocks the read`, () => {
    const dir = mod(path.join(real(tmp.mkdtemp('ch-mauth-08-')), 'many'));
    fs.mkdirSync(path.join(dir, 'f'));
    for (let i = 0; i < check.MAX_ENTRIES; i++) fs.writeFileSync(path.join(dir, 'f', `${i}`), '');
    const r = check.treeProblems(dir);
    assert.strictEqual(r.blocking, true);
    assert.ok(r.problems.some((p) => p.includes(`more than ${check.MAX_ENTRIES} entries`)));
  });

  it('pkgProblems: a scenario with no dependencies passes; any other role, or dependencies, is said', () => {
    assert.deepStrictEqual(check.pkgProblems({countinghouse: {role: 'scenario'}}), []);
    assert.strictEqual(check.pkgProblems({}).length, 1);
    assert.strictEqual(check.pkgProblems(null).length, 1);
    assert.ok(check.pkgProblems({countinghouse: {role: 'scenario'}, dependencies: {a: '1'}})[0].includes('dependencies'));
  });

  it('treeProblems: anything but a file or a folder inside blocks the read', function() {
    if (process.platform === 'win32') this.skip();
    const dir = mod(path.join(real(tmp.mkdtemp('ch-mauth-08-')), 'with-fifo'));
    require('child_process').execFileSync('mkfifo', [path.join(dir, 'api.json')]);
    const r = check.treeProblems(dir);
    assert.strictEqual(r.blocking, true);
    assert.ok(r.problems.some((p) => /neither a file nor a folder \(api\.json\)/.test(p)), JSON.stringify(r.problems));
  });

  it('scrub: whatever follows "cannot be parsed" or "cannot be read" is cut, whatever the parser said', () => {
    assert.strictEqual(check.scrub('api.json cannot be parsed: Unexpected token \'x\', "x;SECRET\nMORE" is not valid JSON'), 'api.json cannot be parsed');
    assert.strictEqual(check.scrub('package.json cannot be read: EACCES'), 'package.json cannot be read');
    assert.strictEqual(check.scrub('the folder holds a link (a)'), 'the folder holds a link (a)');
  });

  it('scrub: a parse error\'s quote of the text it read is cut out', () => {
    let message = null;
    try { JSON.parse('sk-secret-token'); } catch (e) { message = `package.json cannot be parsed: ${e.message}`; }
    assert.ok(message.includes('sk-secret'), 'the runtime\'s Node quotes it');
    const out = check.scrub(message);
    assert.ok(!out.includes('sk-secret') && out === 'package.json cannot be parsed', out);
  });

  tmp.hooks();
});
