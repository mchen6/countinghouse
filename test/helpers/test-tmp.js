// Temporary trees for in-process tests, under the git-ignored test/.tmp
// rather than os.tmpdir() or $HOME: host paths under /tmp are a module's
// virtual /tmp, and the suite should not write into anyone's home. A failed
// run leaves its debris here, where it is easy to find.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
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

// A test file's own trees (forFile): each one it makes is recorded and
// removed when each of its top-level describes ends, failed or not, and a
// pin that the file leaves nothing in os.tmpdir() under its own prefixes (a
// run of a file once grew /tmp by one directory a test). hooks() is the LAST
// line of each top-level describe: mocha runs after() hooks in the order
// they are registered, so the describe's own after() (a server stopped, a
// module unregistered) runs before its trees go. base: under test/.tmp (the
// default), or os.tmpdir() for a module a runtime loads, whose place outside
// the runtime's own tree matters (its resolution, the sandbox's code root).
function forFile(prefixes, {base = BASE} = {}) {
  const made = [];
  const inTmpdir = () => fs.readdirSync(os.tmpdir()).filter((e) => prefixes.some((p) => e.startsWith(p))).length;
  let at = null;
  return {
    mkdtemp(prefix) {
      fs.mkdirSync(base, {recursive: true});
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, prefix)));
      made.push(dir);
      return dir;
    },
    remove,
    hooks() {
      before(() => { if (at == null) at = inTmpdir(); });
      after(() => {
        for (const dir of made.splice(0)) remove(dir);
        const now = inTmpdir();
        const was = at;
        // (said once: a later describe is judged from here)
        at = now;
        // (never more than before: a tree a describe's own before() made
        // under os.tmpdir() is in the count taken, and gone now)
        assert.ok(now <= was, `this file left a ${prefixes.join(' or ')} directory in ${os.tmpdir()} (${was} before, ${now} after)`);
      });
    }
  };
}

module.exports = {mkdtemp, remove, forFile};
