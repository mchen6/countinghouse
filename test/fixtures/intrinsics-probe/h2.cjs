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
  length: () => fs.readFileSync(__filename, 'utf8').length
};
