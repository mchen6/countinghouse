'use strict';
// A checked-in auth fixture as the runtime now reads an auth file: this
// user's own, mode 0600 (B-meter-keys 4r). git keeps a file 0644, so a test
// hands the runtime a private copy: made once per fixture, under test/.tmp,
// removed when the test process exits.
const fs = require('fs');
const path = require('path');
const {mkdtemp, remove} = require('./test-tmp');

const copies = new Map();   // fixture path -> its copy
let dir = null;
process.on('exit', () => { if (dir != null) remove(dir); });

// An auth file as the runtime reads one: on POSIX mode 0600; on Windows made
// with this user's ACL alone, as the runtime makes its own (lib/win-acl.js
// createPrivate), since a file a test writes inherits its folder's ACL
// (Users may read it) whatever mode it is given. Replaces a file there.
function writePrivate(file, text) {
  if (process.platform === 'win32') {
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    require('../../lib/win-acl').createPrivate(file, String(text));
    return file;
  }
  fs.writeFileSync(file, text, {mode: 0o600});
  fs.chmodSync(file, 0o600);
  return file;
}

function privateAuth(fixture) {
  if (copies.has(fixture)) return copies.get(fixture);
  if (dir == null) dir = mkdtemp('ch-private-auth-');
  const copy = path.join(dir, `${copies.size}-${path.basename(fixture)}`);
  writePrivate(copy, fs.readFileSync(fixture, 'utf8'));
  copies.set(fixture, copy);
  return copy;
}

module.exports = {privateAuth, writePrivate};
