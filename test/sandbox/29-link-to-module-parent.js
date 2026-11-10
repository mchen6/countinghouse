// FB3, end to end: a module whose tree holds x -> "." and y -> "x/..", and
// whose handler requires a file through y. Node's JS realpath says y is the
// module's own directory; the kernel opens the directory above it. Under
// enforce the module is refused at load, naming y; its code never runs.
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolErrorCode} = require('../helpers/tool-result');
const {mkdtemp} = require('../helpers/test-tmp');

const KEY = 'aabbcc';
const PORT = 9650;
const NAME = 'handler-map-convention';

// <base>/m is a copy of the handler-map-convention fixture with the two links;
// <base>/outside.js is the file above the module.
function layout() {
  const base = mkdtemp('fb3-load-');
  const m = path.join(base, 'm');
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', NAME), m, {recursive: true});
  fs.writeFileSync(path.join(base, 'outside.js'), 'module.exports = "outside";');
  fs.symlinkSync('.', path.join(m, 'x'));
  fs.symlinkSync('x/..', path.join(m, 'y'));
  fs.writeFileSync(path.join(m, 'handlers', 'greetService', 'hello.js'), [
    'module.exports = async () => {',
    '  let text;',
    '  try { text = require("../../y/outside.js"); } catch (e) { text = `not loaded: ${e.code}`; }',
    '  return {output: {text: text, caller: null}};',
    '};', ''].join('\n'));
  return {base, m};
}

describe('sandbox 29: a link to the module\'s parent (FB3)', function() {
  this.timeout(90000);
  let server = null;
  let made = null;
  afterEach(() => {
    stopServer(server); server = null;
    if (made != null) fs.rmSync(made, {recursive: true, force: true});
    made = null;
  });

  it('enforce refuses the module at load, naming the link; its code never runs', async () => {
    const {base, m} = layout();
    made = base;
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'enforce']);
    const r = await mcpCall(PORT, KEY, 'countinghouse_load_module', {path: m, name: NAME, version: '1.0.0'});
    assert.strictEqual(r.isError, true, JSON.stringify(r));
    assert.strictEqual(toolErrorCode(r), 'MODULE_SANDBOX_REFUSED', JSON.stringify(r));
    assert.ok(server.output.includes(`y is a symlink to ${base}, outside the module`), server.output.slice(-2000));
  });

  // Before FB3 the tree check passed y and the loader's JS realpath placed
  // the file inside the module, where it does not exist: the require failed
  // with no log line, under either mode. Audit now sees what enforce refuses.
  it('audit loads it, logs the refusal enforce would make, and reports the require through y as allowed', async () => {
    const {base, m} = layout();
    made = base;
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread', '--moduleSandbox', 'audit']);
    const r = await mcpCall(PORT, KEY, 'countinghouse_load_module', {path: m, name: NAME, version: '1.0.0'});
    assert.strictEqual(r.structuredContent.loaded, true, JSON.stringify(r));
    assert.ok(server.output.includes(`module sandbox: ${NAME} would be refused under enforce: y is a symlink to ${base}, outside the module`),
      server.output.slice(-2000));
    const call = await mcpCall(PORT, KEY, r.structuredContent.toolNames[0], {name: 'z'});
    assert.strictEqual(call.isError, false, JSON.stringify(call));
    assert.ok(server.output.includes(`module sandbox: ${NAME} violation require ../../y/outside.js (allowed, audit)`), server.output.slice(-2000));
  });
});
