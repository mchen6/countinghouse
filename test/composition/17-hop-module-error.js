// A module's error over a composition hop (logger-and-errors spec,
// docs/superpowers/specs/2026-11-09-logger-design.md §5.1, step 1 (d2)):
// what a composing module's ctx.call rejects with is the same in every mode
// -- single-thread, worker mode through the main thread
// (--no-directPeerChannels), and worker mode over a direct peer channel (the
// default). The callee (test/fixtures/hop-error-callee) returns
// ctx.error(code, message, details); the caller
// (test/fixtures/hop-error-caller) reports the rejection as data. Its auth file,
// 17-auth.json, gives the caller's inner hops an identity (runsModules).
//
// - A code that is also a catalogue name stays the module's (origin module,
//   its own message), so a callee can't pass it off as a runtime error in
//   one mode and not another. Before, worker mode's reply envelopes carried
//   only errMsg/errCode, so the caller rebuilt a plain Error that hopError
//   turned into a runtime-origin CountinghouseError.
// - A code of the module's own crosses whole too (review of #37: hopError
//   passes a module-origin error through, since its origin already says it
//   is not the runtime's).
const assert = require('assert');
const path = require('path');
const spawn = require('child_process').spawn;
const request = require('supertest');
const waitForReady = require('../helpers/wait-for-ready');
const {toolOutput} = require('../helpers/tool-result');
const {CountinghouseError} = require('../../lib/countinghouse-error');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const KEY = 'composition-test-key';

const MODES = [
  {label: 'single-thread', port: 9618, args: ['--no-workerThread']},
  {label: 'worker, main-thread hop', port: 9619, args: ['--workerThread', '--no-directPeerChannels']},
  {label: 'worker, direct peer channel', port: 9620, args: ['--workerThread']}
];

function startServer(mode, done) {
  const server = spawn(process.execPath, [
    path.join(ROOT, 'framework.js'),
    '--bindAddr', '127.0.0.1', '--port', String(mode.port),
    '--authConfigPath', path.join(__dirname, '17-auth.json'),
    '--loadModule', path.join(FIXTURES, 'hop-error-callee'),
    '--loadModule', path.join(FIXTURES, 'hop-error-caller')
  ].concat(mode.args), {stdio: ['ignore', 'pipe', 'pipe']});
  waitForReady(server, done);
  return server;
}

function probe(port, kind, cb) {
  request(`http://127.0.0.1:${port}`)
    .post('/mcp')
    .set('X-CH-Key', KEY)
    .set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {name: 'hop_error_caller_callerservice_probe', arguments: {kind: kind}}})
    .end((err, res) => {
      if (err) return cb(err);
      if (res.body.result == null || res.body.result.isError === true) {
        return cb(new Error(`probe failed: ${JSON.stringify(res.body)}`));
      }
      return cb(null, toolOutput(res.body.result));
    });
}

const observed = {catalogue: {}, own: {}, forgedOrigin: {}, forgedConstructor: {}, passThrough: {}};

MODES.forEach((mode) => {
  describe(`composition 17: a module's error over a hop (${mode.label})`, function() {
    this.timeout(120000);
    let server;

    before((done) => { server = startServer(mode, done); });
    after((done) => {
      if (server == null || server.exitCode != null) return done();
      server.once('exit', () => done());
      server.kill('SIGTERM');
    });

    it('a catalogue-named code stays the module\'s: origin, message and details', (done) => {
      probe(mode.port, 'catalogue', (err, out) => {
        if (err) return done(err);
        observed.catalogue[mode.label] = out;
        assert.deepStrictEqual(out, {
          name: 'CountinghouseError', code: 'DEVICE_NOT_FOUND', message: 'DEVICE_NOT_FOUND: no row 7',
          origin: 'module', kind: 'module', details: {row: 7}
        });
        done();
      });
    });

    it('a code of the module\'s own crosses whole too: code, origin, message and details', (done) => {
      probe(mode.port, 'own', (err, out) => {
        if (err) return done(err);
        observed.own[mode.label] = out;
        assert.deepStrictEqual(out, {
          name: 'CountinghouseError', code: 'SHAPE_GONE', message: 'SHAPE_GONE: the shape is gone',
          origin: 'module', kind: 'module', details: {n: 1}
        });
        done();
      });
    });

    // d2b: a module cannot pass a catalogue code off as the runtime's. Only
    // an error the runtime itself issued keeps origin 'runtime' (a private
    // brand per thread); any other is the module's, whatever its code or
    // `.origin` says.
    for (const kind of ['forgedOrigin', 'forgedConstructor'].concat(mode.args.includes('--no-workerThread') ? [] : ['patchedStatics'])) {
      it(`a callee's catalogue code is the module's however it is built (${kind})`, (done) => {
        probe(mode.port, kind, (err, out) => {
          if (err) return done(err);
          observed[kind] = observed[kind] || {};
          observed[kind][mode.label] = out;
          assert.strictEqual(out.code, 'MODULE_RELOADING', JSON.stringify(out));
          assert.strictEqual(out.origin, 'module', JSON.stringify(out));
          assert.strictEqual(out.kind, 'module', JSON.stringify(out));
          done();
        });
      });
    }

    it('a runtime refusal the callee passes on stays the runtime\'s', (done) => {
      probe(mode.port, 'passThrough', (err, out) => {
        if (err) return done(err);
        observed.passThrough = observed.passThrough || {};
        observed.passThrough[mode.label] = out;
        assert.ok(/^CTX_CALL_/.test(String(out.code)), JSON.stringify(out));
        assert.strictEqual(out.origin, 'runtime', JSON.stringify(out));
        // the catalogue's kind for that code, whatever it is
        assert.strictEqual(out.kind, new CountinghouseError(out.code).kind, JSON.stringify(out));
        done();
      });
    });
  });
});

describe('composition 17: every mode answers alike', () => {
  it('the three modes observed the same rejections', () => {
    for (const kind of ['catalogue', 'own', 'forgedOrigin', 'forgedConstructor', 'passThrough']) {
      // A runtime refusal's message keeps its detail in single-thread mode
      // only (the documented mode difference, ledgered E3); its code, origin
      // and kind are alike.
      const pick = (o) => ((kind === 'passThrough' && o != null) ? {code: o.code, origin: o.origin, kind: o.kind} : o);
      const seen = MODES.map((m) => pick(observed[kind][m.label]));
      assert.ok(seen.every((o) => o !== undefined), `every mode ran the ${kind} probe`);
      seen.forEach((o) => assert.deepStrictEqual(o, seen[0], `${kind}: ${JSON.stringify(seen)}`));
    }
  });
});
