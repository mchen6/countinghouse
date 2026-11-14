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

// The letters tried, from the middle of the alphabet outward: a drive that
// exists is never taken, but one that does not exist now may be mapped
// later, and Windows (net use *) and most tools assign from Z down, so the
// middle is the least likely to meet one.
const ORDER = (() => {
  const letters = [];
  for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) letters.push(String.fromCharCode(c));
  const mid = 'M'.charCodeAt(0);
  return letters.sort((a, b) => Math.abs(a.charCodeAt(0) - mid) - Math.abs(b.charCodeAt(0) - mid) || a.localeCompare(b));
})();

// exists(letter) -> whether "<letter>:\" is a drive here (a test replaces it).
// null when none is free (enforce then refuses to start, framework.js).
// A letter that cannot be looked at (under --hardened the permission model
// refuses the check) is taken as in use.
const driveExists = (l) => { try { return fs.existsSync(`${l}:\\`); } catch (e) { return true; } };
// Under --hardened the permission model refuses the check for every letter:
// the parent, which picks before it relaunches under --permission, hands its
// letter on in CH_VIRTUAL_DRIVE (framework.js), taken only by a child under
// the permission model.
function pick(platform = process.platform, exists = driveExists, env = process.env) {
  if (platform !== 'win32') return null;
  if (picked !== undefined) return picked;
  if (process.permission != null && typeof(env.CH_VIRTUAL_DRIVE) === 'string' && ORDER.includes(env.CH_VIRTUAL_DRIVE)) {
    picked = env.CH_VIRTUAL_DRIVE;
    return picked;
  }
  picked = ORDER.find((l) => !exists(l)) || null;
  return picked;
}

module.exports = {pick, ORDER, reset: () => { picked = undefined; }};
