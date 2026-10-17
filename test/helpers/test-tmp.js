// Temporary trees for in-process tests, under the git-ignored test/.tmp
// rather than os.tmpdir() or $HOME: host paths under /tmp are a module's
// virtual /tmp, and the suite should not write into anyone's home. A failed
// run leaves its debris here, where it is easy to find.
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..', '.tmp');

function mkdtemp(prefix) {
  fs.mkdirSync(BASE, {recursive: true});
  return fs.realpathSync(fs.mkdtempSync(path.join(BASE, prefix)));
}

module.exports = {mkdtemp};
