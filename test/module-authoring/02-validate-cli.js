// bin/countinghouse-validate is the same oracle as lib/module-validator.js,
// reachable from a shell. It exists for humans, for CI, and for agents that
// can run a command but have no MCP server up.
const assert = require('assert');
const path   = require('path');
const exec   = require('child_process').exec;

const ROOT     = path.join(__dirname, '..', '..');
const BIN      = path.join(ROOT, 'bin', 'countinghouse-validate');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function run(args, done) {
  exec(`node ${BIN} ${args}`, {cwd: ROOT}, (err, stdout, stderr) => {
    done({code: err == null ? 0 : err.code, stdout: stdout, stderr: stderr});
  });
}

describe('countinghouse-validate CLI', function() {
  this.timeout(20000);

  it('exits 0 and says so for a clean module', (done) => {
    run(path.join(FIXTURES, 'handler-map-convention'), (r) => {
      assert.strictEqual(r.code, 0);
      assert.ok(/ok/i.test(r.stdout), `expected an ok line, got: ${r.stdout}`);
      done();
    });
  });

  it('exits 1 and prints every problem for a broken module', (done) => {
    run(path.join(FIXTURES, 'handler-map-unknown-service'), (r) => {
      assert.strictEqual(r.code, 1);
      assert.ok(/greetingService/.test(r.stdout + r.stderr));
      done();
    });
  });

  it('exits 2 when the path does not exist', (done) => {
    run(path.join(FIXTURES, 'no-such-module-anywhere'), (r) => {
      assert.strictEqual(r.code, 2);
      done();
    });
  });

  it('exits 2 with usage when given no argument', (done) => {
    run('', (r) => {
      assert.strictEqual(r.code, 2);
      assert.ok(/usage/i.test(r.stdout + r.stderr));
      done();
    });
  });
});
