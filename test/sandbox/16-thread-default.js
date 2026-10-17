// 8.0.0: --workerThread is on unless the operator turns it off, in any of
// the spellings minimist produces. Parsed in a child process so the shared
// cli-options singleton of this mocha run is left untouched.
const assert = require('assert');
const path = require('path');
const {execFileSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function parse(args) {
  const script = `const o = require(${JSON.stringify(path.join(ROOT, 'lib', 'cli-options'))});` +
    `o.setOptions(require(${JSON.stringify(path.join(ROOT, 'node_modules', 'minimist'))})(${JSON.stringify(args)}));` +
    'process.stdout.write(JSON.stringify({workerThread: o.workerThread, moduleSandbox: o.moduleSandbox}));';
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {encoding: 'utf8'}));
}

describe('sandbox 16: --workerThread default', function() {
  this.timeout(20000);
  it('is on with no flag', () => assert.strictEqual(parse([]).workerThread, true));
  it('is on with --workerThread', () => assert.strictEqual(parse(['--workerThread']).workerThread, true));
  it('is off with --no-workerThread', () => assert.strictEqual(parse(['--no-workerThread']).workerThread, false));
  it('is off with --workerThread false', () => assert.strictEqual(parse(['--workerThread', 'false']).workerThread, false));
  it('is off with --workerThread=false', () => assert.strictEqual(parse(['--workerThread=false']).workerThread, false));
  it('makes audit the default sandbox mode', () => assert.strictEqual(parse([]).moduleSandbox, 'audit'));
});
