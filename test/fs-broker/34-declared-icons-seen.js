// A module's declared icon read in a Windows worker (C-win-baseline): the
// worker validates /app as POSIX (identity.pathFor), while the broker
// answers realpath in the module's own spelling, <V>:\app\... (#505).
// declared-icons reads each answer back into the namespace's form at that
// one boundary (roots.virtualFormFor), so its containment check is POSIX's,
// unchanged. Run on every OS: fs answers as a Windows worker's broker does
// -- /app, /data and /tmp respelled <V>:\..., a host path as the host has
// it -- over a real folder, with the win32 form given.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {seenFormFor} = require('../../lib/fs-broker/roots');
const {fromWinFor} = require('../../lib/fs-broker/identity');
const tmp = require('../helpers/test-tmp').forFile(['icons-seen-']);

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d20000000049454e44ae426082', 'hex');

describe('fs-broker 34: a declared icon read in a Windows worker, its realpath in the module\'s own spelling', () => {
  let base;
  let saved = null;
  // (Windows without the symlink privilege: the links can't be made, and
  // each test skips -- never the before() itself, so test-tmp's runs)
  let noLinks = false;
  // (identity's own Windows boundary, for the drive M: what a Windows
  // worker's default form is)
  const winForm = fromWinFor('M');
  const seen = seenFormFor('win32', 'M');
  before(() => {
    // (by the kernel's real path, as the answers below are)
    base = fs.realpathSync.native(tmp.mkdtemp('icons-seen-'));
    for (const d of ['app/icons', 'apple', 'data', 'outside']) fs.mkdirSync(path.join(base, ...d.split('/')), {recursive: true});
    fs.writeFileSync(path.join(base, 'app', 'icons', 'note.png'), PNG);
    for (const f of ['apple/x.png', 'data/d.png', 'outside/secret.png']) fs.writeFileSync(path.join(base, ...f.split('/')), PNG);
    try {
      fs.symlinkSync(path.join(base, 'outside', 'secret.png'), path.join(base, 'app', 'icons', 'leak.png'));
      fs.symlinkSync(path.join(base, 'data', 'd.png'), path.join(base, 'app', 'icons', 'data.png'));
      fs.symlinkSync(path.join(base, 'apple', 'x.png'), path.join(base, 'app', 'icons', 'apple.png'));
    } catch (e) {
      // (Windows without the symlink privilege: the links can't be made here)
      if (e.code === 'EPERM') { noLinks = true; return; }
      throw e;
    }
    // the namespace's /app, /data and /tmp (or M:\... in either separator)
    // are <base>/...; M:\apple is <base>/apple (no namespace root of its own)
    const toHost = (p) => {
      const s = String(p);
      const m = /^M:[\\/](.*)$/.exec(s);
      if (m) return path.join(base, ...m[1].split(/[\\/]/));
      if (/^\/(app|data|tmp)(\/|$)/.test(s)) return path.join(base, ...s.split('/').filter(Boolean));
      return s;
    };
    // the broker's answer: a namespace path respelled as the module sees it,
    // M:\apple as M:\apple, anything else the host's own path
    const answer = (h) => {
      const rel = path.relative(base, h);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return h;
      const v = `/${rel.split(path.sep).join('/')}`;
      return /^\/(app|data|tmp)(\/|$)/.test(v) ? seen(v) : `M:${v.split('/').join('\\')}`;
    };
    saved = {realpath: fs.realpathSync.native, lstat: fs.lstatSync, open: fs.openSync};
    fs.realpathSync.native = (p, o) => answer(saved.realpath(toHost(p), o));
    fs.lstatSync = (p, o) => saved.lstat(toHost(p), o);
    fs.openSync = (p, ...rest) => saved.open(toHost(p), ...rest);
  });
  after(() => {
    if (saved != null) {
      fs.realpathSync.native = saved.realpath;
      fs.lstatSync = saved.lstat;
      fs.openSync = saved.open;
    }
  });
  // (last: its after() runs once this describe's own has put fs back)
  tmp.hooks();

  it('an icon inside the module is read', function() {
    if (noLinks) return this.skip();
    const r = require('../../lib/declared-icons').read('/app', 'icons/note.png', winForm);
    assert.strictEqual(r.problem, undefined, JSON.stringify(r));
    assert.strictEqual(r.mimeType, 'image/png');
  });

  it('a link out of the module is refused: to a host file, to its own /data, to a sibling that only begins like /app', function() {
    if (noLinks) return this.skip();
    const icons = require('../../lib/declared-icons');
    const OUT = {problem: 'is outside the module (a symlink that leaves it)'};
    assert.deepStrictEqual(icons.read('/app', 'icons/leak.png', winForm), OUT, 'a host file');
    assert.deepStrictEqual(icons.read('/app', 'icons/data.png', winForm), OUT, 'the module\'s /data');
    assert.deepStrictEqual(icons.read('/app', 'icons/apple.png', winForm), OUT, 'M:\\apple');
  });

  it('POSIX, nothing respelled: a sibling folder named "app\\y" is outside /app', () => {
    // (an answer only a POSIX broker could give: a name holding "\")
    const restore = fs.realpathSync.native;
    fs.realpathSync.native = (p) => (p === '/app' ? '/app' : '/app\\y/a.png');
    try {
      assert.deepStrictEqual(require('../../lib/declared-icons').read('/app', 'icons/sib.png', (v) => v),
        {problem: 'is outside the module (a symlink that leaves it)'});
    } finally { fs.realpathSync.native = restore; }
  });
});
