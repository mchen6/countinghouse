'use strict';
// Imported, not required, so it keeps its host __filename and a lasting
// read grant (lib/fs-broker/identity.js): a read grant must not write.
const fs = require('fs');
const outcome = (fn) => {
  try {
    fn();
    return {outcome: 'reached'};
  } catch (e) {
    return {outcome: 'refused', code: e != null && e.code != null ? String(e.code) : null};
  }
};
module.exports = {
  // opened for writing, then nothing written
  tryWrite: () => outcome(() => { const fd = fs.openSync(__filename, 'r+'); fs.closeSync(fd); }),
  // a read with a flag that truncates
  tryTruncate: () => outcome(() => fs.readFileSync(__filename, {flag: 'w'})),
  length: () => fs.readFileSync(__filename, 'utf8').length,
  // a descriptor opened read-only through the grant stats, reads and
  // closes, and does nothing else (each change asked for is to what the
  // file already has, so it stays as it was whatever answers)
  fdOps: () => {
    const fd = fs.openSync(__filename, 'r');
    const ops = {};
    try {
      let st = null;
      ops.fstat = outcome(() => { st = fs.fstatSync(fd); });
      ops.read = outcome(() => fs.readSync(fd, Buffer.alloc(16), 0, 16, 0));
      if (st == null) return ops;
      ops.fchmod = outcome(() => fs.fchmodSync(fd, st.mode & 0o7777));
      ops.fchown = outcome(() => fs.fchownSync(fd, st.uid, st.gid));
      ops.futimes = outcome(() => fs.futimesSync(fd, st.atime, st.mtime));
      ops.fsync = outcome(() => fs.fsyncSync(fd));
      ops.ftruncate = outcome(() => fs.ftruncateSync(fd, st.size));
      ops.write = outcome(() => fs.writeSync(fd, 'x', st.size));
    } finally {
      ops.close = outcome(() => fs.closeSync(fd));
    }
    return ops;
  }
};
