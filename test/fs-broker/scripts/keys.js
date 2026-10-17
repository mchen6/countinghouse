// Every fs, fs.promises and FileHandle method is either handled by the patch
// or a known data/class export; anything else fails the test (fail closed).
module.exports = async (fs, root, ctx) => {
  const fsp = require('fs/promises');
  const pass = ctx.patch.PASSTHROUGH;
  const before = fs.readFileSync;
  try { fs.readFileSync = null; } catch (e) { /* non-writable */ }
  return {
    fs: Object.keys(fs).filter((k) => !ctx.handled.fs.has(k) && !pass.fs.includes(k)),
    promises: Object.keys(fsp).filter((k) => !ctx.handled.promises.has(k) && !pass.promises.includes(k)),
    fileHandle: ctx.realFileHandleKeys.filter((k) => !ctx.handled.fileHandle.has(k)),
    locked: fs.readFileSync === before
  };
};
