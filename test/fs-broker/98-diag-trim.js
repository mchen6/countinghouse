// THROWAWAY (C-win-excl, never merged): does Windows trim a link target's
// segment ending in dots or spaces when it resolves the link? A link in
// base/a/b whose target has ".. ", "...", "x." -- where does it land?
const fs = require('fs');
const path = require('path');
const {mkdtemp} = require('../helpers/test-tmp');
describe('DIAG trim', () => {
  it('reports', () => {
    const base = mkdtemp('diag-trim-');
    fs.mkdirSync(path.join(base, 'a', 'b'), {recursive: true});
    fs.writeFileSync(path.join(base, 'a', 'parent.txt'), 'PARENT');
    fs.writeFileSync(path.join(base, 'a', 'b', 'x'), 'X-NO-DOT');
    const out = {};
    for (const [name, target] of [['dotdotSpace', '.. /parent.txt'], ['threeDots', '.../parent.txt'], ['xDot', 'x.'], ['dotdotSpaceBs', '.. \\parent.txt'], ['threeDotsBs', '...\\parent.txt'], ['twoSpaces', '..  /parent.txt']]) {
      const at = path.join(base, 'a', 'b', `l-${name}`);
      const r = {};
      try { fs.symlinkSync(target, at, 'file'); r.made = true; } catch (e) { r.made = e.code; }
      try { r.readlink = fs.readlinkSync(at); } catch (e) { r.readlink = e.code; }
      try { r.read = fs.readFileSync(at, 'utf8'); } catch (e) { r.read = e.code; }
      try { r.realpath = fs.realpathSync.native(at).slice(base.length); } catch (e) { r.realpath = e.code; }
      out[name] = r;
    }
    console.log(`DIAG ${  process.platform  } ${  JSON.stringify(out)}`);
    fs.rmSync(base, {recursive: true, force: true});
  });
});
