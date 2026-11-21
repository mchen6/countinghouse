// A module's declared icon read in a Windows worker (C-win-baseline): the
// worker validates /app with POSIX joins (identity.pathFor), while the broker
// answers realpath in the module's own spelling, <V>:\app\... with "\"
// (#505). An icon inside the module is read; one a link leads out of it, or
// a sibling folder that only begins like the root, is still refused. Run on
// every OS: fs's realpath, lstat and open answer as a Windows worker's broker
// does, over a real folder.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d20000000049454e44ae426082', 'hex');

describe('fs-broker 34: a declared icon read in a Windows worker, its realpath in the module\'s own spelling', () => {
  let base;
  let saved;
  before(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'icons-seen-')));
    fs.mkdirSync(path.join(base, 'app', 'icons'), {recursive: true});
    fs.writeFileSync(path.join(base, 'app', 'icons', 'note.png'), PNG);
    fs.mkdirSync(path.join(base, 'apple'), {recursive: true});
    fs.writeFileSync(path.join(base, 'apple', 'x.png'), PNG);
    fs.mkdirSync(path.join(base, 'outside'), {recursive: true});
    fs.writeFileSync(path.join(base, 'outside', 'secret.png'), PNG);
    fs.symlinkSync(path.join(base, 'outside', 'secret.png'), path.join(base, 'app', 'icons', 'leak.png'));
    // (M:\app\..., in either separator, is <base>/app/...; M:\apple\... is
    // <base>/apple/...: the broker's answers come back as M:\..., with "\")
    const toHost = (p) => {
      const s = String(p);
      if (s === '/app' || s.startsWith('/app/')) return path.join(base, s);
      const m = /^M:[\\/](.*)$/.exec(s);
      return m ? path.join(base, ...m[1].split(/[\\/]/)) : s;
    };
    const toSeen = (h) => {
      const rel = path.relative(base, h);
      return rel.startsWith('..') || path.isAbsolute(rel) ? h : `M:\\${rel.split(path.sep).join('\\')}`;
    };
    saved = {realpath: fs.realpathSync.native, lstat: fs.lstatSync, open: fs.openSync};
    fs.realpathSync.native = (p, o) => toSeen(saved.realpath(toHost(p), o));
    fs.lstatSync = (p, o) => saved.lstat(toHost(p), o);
    fs.openSync = (p, ...rest) => saved.open(toHost(p), ...rest);
  });
  after(() => {
    fs.realpathSync.native = saved.realpath;
    fs.lstatSync = saved.lstat;
    fs.openSync = saved.open;
    fs.rmSync(base, {recursive: true, force: true});
  });

  it('an icon inside the module is read; one a link leads out of, refused', () => {
    const icons = require('../../lib/declared-icons');
    const r = icons.read('/app', 'icons/note.png');
    assert.strictEqual(r.problem, undefined, JSON.stringify(r));
    assert.strictEqual(r.mimeType, 'image/png');
    assert.deepStrictEqual(icons.read('/app', 'icons/leak.png'), {problem: 'is outside the module (a symlink that leaves it)'});
  });

  it('a folder that only begins like the root is outside it', () => {
    const icons = require('../../lib/declared-icons');
    // (the root answers M:\app; a link to M:\apple\x.png leads out of it)
    fs.symlinkSync(path.join(base, 'apple', 'x.png'), path.join(base, 'app', 'icons', 'apple.png'));
    assert.deepStrictEqual(icons.read('/app', 'icons/apple.png'), {problem: 'is outside the module (a symlink that leaves it)'});
  });
});
