// Single-thread (debug) mode: modules get their own /data and /tmp, and their
// fs and os translate /app, /data and /tmp (part 2 spec, section 6). No
// sandbox: only translation.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, post} = require('../helpers/sandbox-server');
const {mkdtemp} = require('../helpers/test-tmp');

const PORT = 9636;
const KEY = 'k';
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const out = (r) => (r.structuredContent != null ? r.structuredContent.output : r);

describe('single-thread 01: data directories and the fs/os facade', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  afterEach(() => { stopServer(server); server = null; if (base) fs.rmSync(base, {recursive: true, force: true}); base = null; });

  const store = () => path.join(base, 'store');
  const start = (modules) => {
    base = mkdtemp('single-');
    fs.mkdirSync(path.join(store(), 'fs-probe', 'tmp'), {recursive: true});
    fs.writeFileSync(path.join(store(), 'fs-probe', 'tmp', 'old'), 'stale');
    return startServer(PORT, ['--no-workerThread', '--debug', '--debugKey', KEY, '--moduleDataPath', store()]
      .concat(...modules.map((m) => ['--loadModule', path.join(FIXTURES, m)])));
  };

  it('/data is the module\'s own directory; /tmp is emptied at load; os.tmpdir() is /tmp', async () => {
    server = await start(['fs-probe']);
    const w = out(await mcpCall(PORT, KEY, 'fs_probe_probeservice_write', {path: '/data/x', content: 'mine'}));
    assert.deepStrictEqual(w, {ok: true, code: null}, server.output.slice(-2000));
    assert.strictEqual(fs.readFileSync(path.join(store(), 'fs-probe', 'data', 'x'), 'utf8'), 'mine');
    assert.deepStrictEqual(out(await mcpCall(PORT, KEY, 'fs_probe_probeservice_read', {path: '/data/x'})), {content: 'mine', code: null});
    assert.deepStrictEqual(out(await mcpCall(PORT, KEY, 'fs_probe_probeservice_read', {path: '/tmp/old'})), {content: null, code: 'ENOENT'});
    const where = out(await mcpCall(PORT, KEY, 'fs_probe_probeservice_where', {}));
    assert.strictEqual(where.tmpdir, '/tmp');
    assert.strictEqual(where.own, 'fs-probe');
  });

  it('results come back virtual; an absolute symlink target is translated; relative paths resolve against /app', async () => {
    server = await start(['fs-probe']);
    const r = out(await mcpCall(PORT, KEY, 'fs_probe_probeservice_fsresults', {}));
    assert.deepStrictEqual(r, {realpath: '/data', mkdtemp: '/tmp/x-*', parent: '/data', relative: true, mkdirFirst: '/data/a'}, JSON.stringify(r));
    const data = path.join(store(), 'fs-probe', 'data');
    assert.strictEqual(fs.readlinkSync(path.join(data, 'l')), path.join(data, 'x'));
  });

  it('an ES-module module\'s named imports from node:fs work and translate (review I1)', async () => {
    server = await start(['esm-probe']);
    assert.deepStrictEqual(out(await mcpCall(PORT, KEY, 'esm_probe_probeservice_readown', {})), {name: 'esm-probe', real: '/data'});
  });

  it('countinghouse\'s own fs is never translated: a second module loads after the first', async () => {
    server = await start(['fs-probe']);
    await mcpCall(PORT, KEY, 'fs_probe_probeservice_write', {path: '/data/x', content: 'x'});
    const r = await post(PORT, KEY, '/load-module', {path: path.join(FIXTURES, 'esm-probe'), name: 'esm-probe'});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });
});
