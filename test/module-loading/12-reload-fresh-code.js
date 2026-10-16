// A reload must run the module's current code -- all of it, not just the
// files CHUtil.loadFile happened to load -- and under --workerThread it must
// run that code in the module's worker, never in the main thread.
//
// Before this test existed, CHUtil.loadFile used rewire, which re-evaluates
// only the file it is given: everything that file require()s still came from
// the reused worker's require cache, so after editing a helper and reloading,
// the handler was new and its helper was old. POST /reload-module was worse:
// it instantiated the module in the main thread even under --workerThread.
//
// Each server gets a fresh copy of test/fixtures/reload-fresh-code in a temp
// directory, so the edits below never touch the repository.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const spawn   = require('child_process').spawn;
const request = require('supertest');
const waitForReady = require('../helpers/wait-for-ready');

const ROOT    = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'reload-fresh-code');
const KEY     = 'aabbcc';
const TOOL    = 'reload_fresh_code_greetservice_hello';
const MARKER  = 'RELOAD_FIXTURE_DEP_LOADED';

function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-reload-fresh-code-'));
  fs.cpSync(FIXTURE, dir, {recursive: true});
  return dir;
}

function setGreeting(dir, word) {
  const file = path.join(dir, 'lib', 'greeting.js');
  const src  = fs.readFileSync(file, 'utf8').replace(/word: '[a-z]+'/, `word: '${word}'`);
  fs.writeFileSync(file, src);
}

// extraArgs decides the mode; stdout is collected so tests can look for the
// fixture's console marker.
function startServer(port, extraArgs, done) {
  const server = spawn(process.execPath,
    [path.join(ROOT, 'framework.js'), '--bindAddr', '127.0.0.1', '--port', String(port)].concat(extraArgs),
    {cwd: ROOT, env: Object.assign({}, process.env, {NODE_PATH: path.join(ROOT, 'lib')}),
     stdio: ['ignore', 'pipe', 'ignore'], detached: true});
  server.output = '';
  server.stdout.on('data', (chunk) => { server.output += chunk.toString(); });
  waitForReady(server, (err) => done(err, server));
}

// try/catch: the server may already be gone if an earlier step failed.
function stopServer(server) {
  if (server == null || server.pid == null) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
}

function mcp(port, method, params, cb) {
  request(`http://127.0.0.1:${port}`)
    .post('/mcp')
    .set('X-CH-Key', KEY)
    .send({jsonrpc: '2.0', id: Date.now(), method: method, params: params})
    .end((err, res) => cb(err, res && res.body));
}

function loadModule(port, dir, cb) {
  mcp(port, 'tools/call', {name: 'countinghouse_load_module',
    arguments: {path: dir, name: 'reload-fresh-code', version: '1.0.0'}}, (err, body) => {
    if (err) return cb(err);
    const out = body.result.structuredContent;
    assert.strictEqual(out.loaded, true, `load_module failed: ${JSON.stringify(body.result)}`);
    assert.ok(out.toolNames.indexOf(TOOL) !== -1, `expected ${TOOL}, got ${out.toolNames.join(', ')}`);
    return cb();
  });
}

function greet(port, cb) {
  mcp(port, 'tools/call', {name: TOOL, arguments: {name: 'world'}}, (err, body) => {
    if (err) return cb(err);
    assert.strictEqual(body.result.isError, false, `tool call failed: ${JSON.stringify(body.result)}`);
    return cb(null, body.result.structuredContent.output.text);
  });
}

// The device can be briefly absent while a reload replaces it; poll until it
// answers with the expected text or the budget runs out, then report the
// last answer seen.
function expectGreeting(port, expected, done) {
  const deadline = Date.now() + 20000;
  let last = null;
  (function attempt() {
    mcp(port, 'tools/call', {name: TOOL, arguments: {name: 'world'}}, (err, body) => {
      if (err == null && body.result != null && body.result.isError === false) {
        last = body.result.structuredContent.output.text;
        if (last === expected) return done();
      } else {
        last = err != null ? err.message : JSON.stringify(body && (body.result || body.error));
      }
      if (Date.now() > deadline) {
        return done(new Error(`expected "${expected}" after reload, last answer: ${last}`));
      }
      return setTimeout(attempt, 250);
    });
  })();
}

describe('module reload runs the current code', function() {
  this.timeout(60000);

  describe('under --workerThread', () => {
    const PORT = 9602;
    let server = null;
    let dir = null;

    before((done) => {
      dir = copyFixture();
      startServer(PORT, ['--debug', '--debugKey', KEY, '--authoringTools', '--workerThread'], (err, s) => {
        server = s;
        done(err);
      });
    });
    after(() => {
      stopServer(server);
      if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    });

    it('loads the module', (done) => {
      loadModule(PORT, dir, (err) => {
        if (err) return done(err);
        greet(PORT, (err, text) => {
          if (err) return done(err);
          assert.strictEqual(text, 'hello world');
          done();
        });
      });
    });

    it('a reload through load_module picks up an edited helper file', (done) => {
      setGreeting(dir, 'hi');
      loadModule(PORT, dir, (err) => {
        if (err) return done(err);
        expectGreeting(PORT, 'hi world', done);
      });
    });

    it('POST /reload-module picks up an edited helper file without running module code in the main thread', (done) => {
      setGreeting(dir, 'hey');
      request(`http://127.0.0.1:${PORT}`)
        .post('/reload-module')
        .set('X-CH-Key', KEY)
        .send({path: dir})
        .end((err) => {
          if (err) return done(err);
          expectGreeting(PORT, 'hey world', (err) => {
            if (err) return done(err);
            assert.ok(server.output.indexOf(`${MARKER} main=true`) === -1,
              'module code ran in the main thread under --workerThread');
            done();
          });
        });
    });
  });

  describe('in single-thread mode', () => {
    const PORT = 9603;
    let server = null;
    let dir = null;

    before((done) => {
      dir = copyFixture();
      startServer(PORT, ['--debug', '--debugKey', KEY, '--authoringTools'], (err, s) => {
        server = s;
        done(err);
      });
    });
    after(() => {
      stopServer(server);
      if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    });

    it('a reload through load_module picks up an edited helper file', (done) => {
      loadModule(PORT, dir, (err) => {
        if (err) return done(err);
        setGreeting(dir, 'hi');
        loadModule(PORT, dir, (err) => {
          if (err) return done(err);
          expectGreeting(PORT, 'hi world', done);
        });
      });
    });
  });

  // Release mode (no --debug) drops module console output. That used to be
  // done per file by rewire, so a module's dependencies kept printing.
  describe('console in release mode under --workerThread', () => {
    const PORT = 9604;
    let server = null;
    let dir = null;

    before((done) => {
      dir = copyFixture();
      startServer(PORT, ['--workerThread', '--loadModule', dir], (err, s) => {
        server = s;
        done(err);
      });
    });
    after(() => {
      stopServer(server);
      if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    });

    it('is silenced for the module\'s dependencies too', () => {
      assert.ok(server.output.indexOf(MARKER) === -1,
        `a dependency's console.log reached stdout in release mode:\n${server.output.slice(-1000)}`);
    });
  });
});
