// THROWAWAY (C-win-devseg, never merged): does Node's fs on Windows reach a
// device or trim a name? A plain dir: write/read COM1, NUL.txt, CON .log,
// note. ; read note::$DATA and note:alt. Reports what each did.
const fs = require('fs');
const path = require('path');
const {mkdtemp} = require('../helpers/test-tmp');
describe('DIAG names', () => {
  it('reports', () => {
    const base = mkdtemp('diag-names-');
    fs.writeFileSync(path.join(base, 'note'), 'the note');
    const out = {};
    for (const n of ['COM1', 'nul.txt', 'con .log', 'note.', 'note ', 'AUX']) {
      const p = path.join(base, n);
      const r = {};
      try { fs.writeFileSync(p, 'w'); r.write = 'ok'; } catch (e) { r.write = e.code; }
      try { r.entries = fs.readdirSync(base).filter((x) => x.toLowerCase().startsWith(n.slice(0, 3).toLowerCase())); } catch (e) { r.entries = e.code; }
      try { r.readBack = fs.readFileSync(p, 'utf8'); } catch (e) { r.readBack = e.code; }
      out[n] = r;
    }
    try { out.noteAfter = fs.readFileSync(path.join(base, 'note'), 'utf8'); } catch (e) { out.noteAfter = e.code; }
    for (const n of ['note::$DATA', 'note:alt']) {
      const r = {};
      try { r.read = fs.readFileSync(path.join(base, n), 'utf8'); } catch (e) { r.read = e.code; }
      try { fs.writeFileSync(path.join(base, n), 'stream'); r.write = 'ok'; } catch (e) { r.write = e.code; }
      try { r.readAfter = fs.readFileSync(path.join(base, n), 'utf8'); } catch (e) { r.readAfter = e.code; }
      out[n] = r;
    }
    try { out.noteFinal = fs.readFileSync(path.join(base, 'note'), 'utf8'); } catch (e) { out.noteFinal = e.code; }
    console.log(`DIAG ${process.platform} ${JSON.stringify(out)}`);
    fs.rmSync(base, {recursive: true, force: true});
  });
});
