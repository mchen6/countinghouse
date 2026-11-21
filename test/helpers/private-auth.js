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

function privateAuth(fixture) {
  if (copies.has(fixture)) return copies.get(fixture);
  if (dir == null) dir = mkdtemp('ch-private-auth-');
  const copy = path.join(dir, `${copies.size}-${path.basename(fixture)}`);
  fs.writeFileSync(copy, fs.readFileSync(fixture), {mode: 0o600});
  fs.chmodSync(copy, 0o600);
  copies.set(fixture, copy);
  return copy;
}

module.exports = {privateAuth};
