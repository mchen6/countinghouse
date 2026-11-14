// The drive a module's files carry on Windows (#195). A module's identity is
// its files as /app/... (lib/fs-broker/identity.js); Node on win32 takes a
// file URL only with a drive, so there a module file is file:///<V>:/app/...,
// and the module sees its files, and its current directory, as <V>:\app\....
// V is a drive letter this host does not have, picked once per process on
// the main thread and given to each module worker (workerData.virtualDrive):
// nothing on the host is ever named by it, and the file broker maps
// <V>:\app back to /app (lib/fs-broker/roots.js). null off Windows.
const fs = require('fs');

let picked;

// exists(letter) -> whether "<letter>:\" is a drive here (a test replaces it).
function pick(platform = process.platform, exists = (l) => fs.existsSync(`${l}:\\`)) {
  if (platform !== 'win32') return null;
  if (picked !== undefined) return picked;
  picked = null;
  for (let c = 'Z'.charCodeAt(0); c >= 'D'.charCodeAt(0); c--) {
    const l = String.fromCharCode(c);
    if (!exists(l)) { picked = l; break; }
  }
  return picked;
}

module.exports = {pick, reset: () => { picked = undefined; }};
