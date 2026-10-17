// The single-thread facade is per module parent: code outside every
// registered module root (countinghouse's own) gets the real fs, fs/promises
// and os; code inside a root gets the translating facade (Review Focus 4).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const facade = require('../../lib/single-thread-facade');
const {mkdtemp} = require('../helpers/test-tmp');

describe('single-thread 00: the facade is per module parent', () => {
  let base = null;
  after(() => { if (base) fs.rmSync(base, {recursive: true, force: true}); });

  it('a module file gets the facade; a file outside every module root gets the real modules', () => {
    base = fs.realpathSync(mkdtemp('facade-unit-'));
    const root = path.join(base, 'mod');
    const outside = path.join(base, 'outside');
    [root, outside, path.join(base, 'data'), path.join(base, 'tmp')].forEach((d) => fs.mkdirSync(d, {recursive: true}));
    const probe = "module.exports = {fs: require('fs'), fsp: require('fs/promises'), nodeFs: require('node:fs'), os: require('os')};\n";
    fs.writeFileSync(path.join(root, 'probe.js'), probe);
    fs.writeFileSync(path.join(outside, 'probe.js'), probe);
    facade.install();
    facade.register(root, {name: 'mod', data: path.join(base, 'data'), tmp: path.join(base, 'tmp')});

    const inner = require(path.join(root, 'probe.js'));
    const outer = require(path.join(outside, 'probe.js'));
    const real = {fs: process.getBuiltinModule('fs'), fsp: process.getBuiltinModule('fs/promises'), os: process.getBuiltinModule('os')};

    assert.strictEqual(outer.fs, real.fs);
    assert.strictEqual(outer.nodeFs, real.fs);
    assert.strictEqual(outer.fsp, real.fsp);
    assert.strictEqual(outer.os, real.os);

    assert.notStrictEqual(inner.fs, real.fs);
    assert.notStrictEqual(inner.fsp, real.fsp);
    assert.strictEqual(inner.os.tmpdir(), '/tmp');
    inner.fs.writeFileSync('/data/x', 'via facade');
    assert.strictEqual(fs.readFileSync(path.join(base, 'data', 'x'), 'utf8'), 'via facade');
  });

  it('the longest registered root wins (review M4)', () => {
    facade.register('/r/outer', {name: 'outer', data: '/d1', tmp: '/t1'});
    facade.register('/r/outer/node_modules/inner', {name: 'inner', data: '/d2', tmp: '/t2'});
    assert.strictEqual(facade.rootOf('/r/outer/node_modules/inner/index.js'), '/r/outer/node_modules/inner');
    assert.strictEqual(facade.rootOf('/r/outer/index.js'), '/r/outer');
    assert.strictEqual(facade.rootOf('/elsewhere/x.js'), null);
  });
});
