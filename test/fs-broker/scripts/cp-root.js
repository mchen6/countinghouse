// cp of a file onto a declared rw root not made yet, whose parent exists
// (fs-broker 36, the high's F3): copied, no parent made, nothing refused.
const path = require('path');

module.exports = async (fs, root, ctx) => {
  const fsp = require('fs/promises');
  fs.writeFileSync(path.posix.join(root, 'f.txt'), 'hello');
  const out = {};
  const target = (n) => path.join(ctx.extra.base, 'decl', n);
  try { fs.cpSync(path.posix.join(root, 'f.txt'), target('one.txt')); out.sync = fs.readFileSync(target('one.txt'), 'utf8'); } catch (e) { out.sync = `throws ${e.code}`; }
  try { await fsp.cp(path.posix.join(root, 'f.txt'), target('two.txt')); out.promise = fs.readFileSync(target('two.txt'), 'utf8'); } catch (e) { out.promise = `throws ${e.code}`; }
  return out;
};
