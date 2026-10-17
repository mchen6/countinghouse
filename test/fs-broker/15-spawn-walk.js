const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const walk = require('../../lib/fs-broker/spawn-walk');
const {mkdtemp} = require('../helpers/test-tmp');

describe('fs-broker 15: the spawn walk', () => {
  let base = null;
  let outside = null;
  afterEach(() => { [base, outside].forEach((d) => d && fs.rmSync(d, {recursive: true, force: true})); base = outside = null; });

  it('empties /tmp without following links', async () => {
    base = mkdtemp('walk-');
    outside = fs.mkdtempSync(path.join(os.homedir(), '.ch-walk-outside-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(path.join(tmp, 'd'), {recursive: true});
    fs.writeFileSync(path.join(tmp, 'd', 'f'), 'x');
    fs.symlinkSync(outside, path.join(tmp, 'link-to-outside'));
    await walk.emptyTmp(tmp);
    assert.deepStrictEqual(fs.readdirSync(tmp), []);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  });

  it('refuses to empty a /tmp root that is a link', async () => {
    base = mkdtemp('walk-');
    outside = fs.mkdtempSync(path.join(os.homedir(), '.ch-walk-outside-'));
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    fs.symlinkSync(outside, path.join(base, 'tmp'));
    await assert.rejects(walk.emptyTmp(path.join(base, 'tmp')), /not a directory/);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  });

  it('measures logical bytes once per inode and one entry per name, and lists absolute symlinks and links that lead outside', async () => {
    base = mkdtemp('walk-');
    const data = path.join(base, 'data');
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(path.join(data, 'sub'), {recursive: true});
    fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(data, 'a'), Buffer.alloc(1000));
    fs.linkSync(path.join(data, 'a'), path.join(data, 'sub', 'a2'));       // hard link inside: bytes once, two entries, not listed
    outside = fs.mkdtempSync(path.join(os.homedir(), '.ch-walk-outside-'));
    fs.writeFileSync(path.join(outside, 'o'), Buffer.alloc(10));
    fs.linkSync(path.join(outside, 'o'), path.join(data, 'out'));           // a link whose other name is outside: listed
    const sparse = fs.openSync(path.join(data, 'sparse'), 'w'); fs.ftruncateSync(sparse, 5000); fs.closeSync(sparse);
    fs.symlinkSync('a', path.join(data, 'rel'));                               // relative: fine
    fs.symlinkSync('/etc/hostname', path.join(data, 'abs'));                   // absolute: listed
    const r = await walk.measure([[data, '/data'], [tmp, '/tmp']], {maxListed: 10});
    assert.strictEqual(r.bytes, 6010);
    assert.strictEqual(r.entries, 7);   // sub, a, sub/a2, out, sparse, rel, abs
    assert.deepStrictEqual(r.links.sort(), ['/data/abs', '/data/out'].sort());
    assert.strictEqual(r.moreLinks, 0);
  });

  it('whollyInside counts a file\'s bytes only when all its links are inside the walked tree (review I1)', async () => {
    base = mkdtemp('walk-');
    const data = path.join(base, 'data');
    fs.mkdirSync(path.join(data, 'd'), {recursive: true});
    fs.writeFileSync(path.join(data, 'big'), Buffer.alloc(1000));
    fs.linkSync(path.join(data, 'big'), path.join(data, 'd', 'x'));
    fs.writeFileSync(path.join(data, 'd', 'own'), Buffer.alloc(30));
    const sub = await walk.measure([[path.join(data, 'd'), '/data/d']], {whollyInside: true});
    assert.strictEqual(sub.bytes, 30, 'd/x shares its inode with /data/big, which stays');
    assert.strictEqual(sub.entries, 2);
  });
});
