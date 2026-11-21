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
    const l = check.treeProblems(linked, {countinghouse: {role: 'scenario'}});
    assert.strictEqual(l.blocking, true);
    assert.ok(l.problems.some((p) => /link \(api\.json\)/.test(p)), JSON.stringify(l.problems));
    const twice = mod(path.join(base, 'twice'));
    fs.linkSync(secret, path.join(twice, 'api.json'));
    const t = check.treeProblems(twice, {countinghouse: {role: 'scenario'}});
    assert.strictEqual(t.blocking, true);
    assert.ok(t.problems.some((p) => /second name \(api\.json\)/.test(p)), JSON.stringify(t.problems));
    assert.strictEqual(check.treeProblems(mod(path.join(base, 'plain')), {countinghouse: {role: 'scenario'}}).blocking, false);
  });

  it(`treeProblems: more than ${check.MAX_ENTRIES} entries blocks the read`, () => {
    const dir = mod(path.join(real(tmp.mkdtemp('ch-mauth-08-')), 'many'));
    fs.mkdirSync(path.join(dir, 'f'));
    for (let i = 0; i < check.MAX_ENTRIES; i++) fs.writeFileSync(path.join(dir, 'f', `${i}`), '');
    const r = check.treeProblems(dir, {countinghouse: {role: 'scenario'}});
    assert.strictEqual(r.blocking, true);
    assert.ok(r.problems.some((p) => p.includes(`more than ${check.MAX_ENTRIES} entries`)));
  });

  it('scrub: a parse error\'s quote of the text it read is cut out', () => {
    let message = null;
    try { JSON.parse('sk-secret-token'); } catch (e) { message = `package.json cannot be parsed: ${e.message}`; }
    assert.ok(message.includes('sk-secret'), 'the runtime\'s Node quotes it');
    const out = check.scrub(message);
    assert.ok(!out.includes('sk-secret') && /is not valid JSON/.test(out), out);
  });

  tmp.hooks();
});
