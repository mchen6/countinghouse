// The authoring tools are admin-gated AND off unless --authoringTools is
// passed. Default-off is a safety property, not a preference:
// countinghouse_load_module plus countinghouse_call_tool is arbitrary code
// execution with a friendly name, and must not be one flag-flip away on a
// deployment that merely happens to have an admin key configured.
//
// Default-off is also what keeps the golden tools/list surface still --
// test/mcp-contract/capture-tools-list.js never passes the flag -- so the
// first case here is the regression guard for that too.
const assert  = require('assert');
const path    = require('path');
const spawn   = require('child_process').spawn;
const request = require('supertest');

const ROOT = path.join(__dirname, '..', '..');
const AUTHORING_NAMES = [
  'countinghouse_validate_plan',
  'countinghouse_validate_module',
  'countinghouse_load_module',
  'countinghouse_call_tool'
];

function startServer(port, extraArgs, done) {
  const args = ['--debug', '--bindAddr', '127.0.0.1', '--port', String(port),
                '--debugKey', 'aabbcc'].concat(extraArgs);
  const server = spawn(path.join(ROOT, 'bin', 'countinghouse'), args,
                       {cwd: ROOT, stdio: 'ignore', detached: true});
  setTimeout(() => done(server), 6000);
}

function toolsList(port, cb) {
  request(`http://127.0.0.1:${port}`)
    .post('/mcp')
    .set('X-CH-Key', 'aabbcc')
    .send({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})
    .end((err, res) => cb(err, res && res.body && res.body.result));
}

describe('authoring tools: absent unless --authoringTools', function() {
  this.timeout(30000);
  let server = null;
  const PORT = 9550;

  before((done) => { startServer(PORT, [], (s) => { server = s; done(); }); });
  after(() => { if (server != null) process.kill(-server.pid); });

  it('lists none of the four authoring tools', (done) => {
    toolsList(PORT, (err, result) => {
      assert.ifError(err);
      const names = result.tools.map((t) => t.name);
      AUTHORING_NAMES.forEach((n) => {
        assert.ok(names.indexOf(n) === -1, `${n} must not be listed without --authoringTools`);
      });
      done();
    });
  });

  it('refuses to call one even for an admin key', (done) => {
    request(`http://127.0.0.1:${PORT}`)
      .post('/mcp')
      .set('X-CH-Key', 'aabbcc')
      .send({jsonrpc: '2.0', id: 2, method: 'tools/call',
             params: {name: 'countinghouse_validate_module', arguments: {path: '.'}}})
      .end((err, res) => {
        assert.ifError(err);
        assert.ok(res.body.result == null || res.body.result.isError === true,
                  'calling a disabled authoring tool must not succeed');
        done();
      });
  });
});

describe('authoring tools: present with --authoringTools', function() {
  this.timeout(30000);
  let server = null;
  const PORT = 9551;

  before((done) => { startServer(PORT, ['--authoringTools'], (s) => { server = s; done(); }); });
  after(() => { if (server != null) process.kill(-server.pid); });

  it('lists countinghouse_validate_module', (done) => {
    toolsList(PORT, (err, result) => {
      assert.ifError(err);
      const names = result.tools.map((t) => t.name);
      assert.ok(names.indexOf('countinghouse_validate_module') !== -1);
      done();
    });
  });

  it('validates a clean fixture through the tool', (done) => {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-convention');
    request(`http://127.0.0.1:${PORT}`)
      .post('/mcp')
      .set('X-CH-Key', 'aabbcc')
      .send({jsonrpc: '2.0', id: 3, method: 'tools/call',
             params: {name: 'countinghouse_validate_module', arguments: {path: fixture}}})
      .end((err, res) => {
        assert.ifError(err);
        assert.strictEqual(res.body.result.isError, false);
        assert.strictEqual(res.body.result.structuredContent.ok, true);
        done();
      });
  });

  it('returns the full problem list for a broken fixture', (done) => {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-unknown-service');
    request(`http://127.0.0.1:${PORT}`)
      .post('/mcp')
      .set('X-CH-Key', 'aabbcc')
      .send({jsonrpc: '2.0', id: 4, method: 'tools/call',
             params: {name: 'countinghouse_validate_module', arguments: {path: fixture}}})
      .end((err, res) => {
        assert.ifError(err);
        const out = res.body.result.structuredContent;
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.problems.length, 2);
        done();
      });
  });
});
