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

// A test directory's removal, retried: on Windows a process just ended can
// still hold handles under it for a moment.
function remove(dir) {
  if (dir != null) fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
}

module.exports = {mkdtemp, remove};
