// --hardened re-launches under Node's permission model: a module cannot read
// the process's memory or environment files, and every module must live
// under --modulePath.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {toolOutput, toolErrorCode} = require('../helpers/tool-result');
const {CAPTURE_SOURCE} = require('../helpers/lockdown-worker');
const {startStandIn} = require('../helpers/lazy-net-stand-in');

const KEY = 'aabbcc';

function moduleRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hardened-'));
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'sandbox-probe'), path.join(root, 'sandbox-probe'), {recursive: true});
  // A handler that reads a file it names, so the test can aim it at /proc.
  fs.writeFileSync(path.join(root, 'sandbox-probe', 'handlers', 'probeService', 'attempt.js'),
    'module.exports = async (input) => { try { require("fs").readFileSync(input.arg); return {output: {outcome: "allowed", code: null}}; }' +
    ' catch (e) { return {output: {outcome: e.code === "ERR_ACCESS_DENIED" ? "blocked" : "allowed", code: String(e.code)}}; } };');
  return root;
}

// The descriptor routes, each aimed at a descriptor number no process has.
const FD_ATTEMPT = `const net = require('net');
const FD = 999999;
${CAPTURE_SOURCE}
const forms = {
  option: () => new net.Socket({fd: FD}),
  number: () => new net.Socket(FD),
  connect: () => net.connect({fd: FD}),
  createConnection: () => net.createConnection({fd: FD}),
  request: () => require('http').request({host: '127.0.0.1', port: 1, fd: FD}),
  arraySocket: () => new net.Socket(Object.assign([], {fd: FD})),
  arrayConnect: () => net.connect(Object.assign([], {fd: FD})),
  arrayListen: () => net.createServer().listen(Object.assign([], {fd: FD})),
  tcpOpen: () => new (capture.TCP().constructor)(0).open(FD),
  pipeOpen: () => new (capture.Pipe().constructor)(0).open(FD),
  udpOpen: () => new (capture.UDP().constructor)().open(FD),
  socketCtor: () => new (net.Socket.prototype.constructor)(FD),
  ttyWriteCtor: () => new (require('tty').WriteStream.prototype.constructor)(FD),
  ttyReadCtor: () => new (require('tty').ReadStream.prototype.constructor)(FD),
  ttySuper: () => new (Object.getPrototypeOf(require('tty').WriteStream))(FD),
  tlsSuper: () => new (Object.getPrototypeOf(require('tls').TLSSocket))(FD),
};
module.exports = async (input) => {
  try {
    if (input.arg === 'getter') {
      let reads = 0;
      const s = new net.Socket({get fd() { return reads++ > 0 ? FD : undefined; }});
      return {output: {outcome: s._handle == null ? 'not adopted' : 'adopted', reads: reads}};
    }
    forms[input.arg]();
    return {output: {outcome: 'allowed', code: null}};
  } catch (e) {
    return {output: {outcome: e.code === 'ERR_ACCESS_DENIED' ? 'blocked' : 'allowed', code: String(e.code)}};
  }
};
`;

async function startFdProbe(root) {
  fs.writeFileSync(path.join(root, 'sandbox-probe', 'handlers', 'probeService', 'attempt.js'), FD_ATTEMPT);
  return startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened', '--moduleSandbox', 'enforce',
    '--modulePath', root, '--loadModule', path.join(root, 'sandbox-probe')]);
}
const fdAttempt = async (form) => toolOutput(await mcpCall(9614, KEY, 'sandbox_probe_probeservice_attempt', {what: 'socket', arg: form}));

describe('sandbox 09: --hardened', function() {
  this.timeout(90000);
  let server = null;
  let root = null;
  beforeEach(() => { root = moduleRoot(); });
  afterEach(() => { stopServer(server); server = null; fs.rmSync(root, {recursive: true, force: true}); });

  it('runs under the permission model and blocks /proc/self/environ and /proc/self/mem', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened',
      '--modulePath', root, '--loadModule', path.join(root, 'sandbox-probe')]);
    assert.ok(server.output.includes('module sandbox: hardened -- running under --permission'), server.output.slice(-2000));
    for (const file of ['/proc/self/environ', '/proc/self/mem']) {
      const r = await mcpCall(9614, KEY, 'sandbox_probe_probeservice_attempt', {what: 'read', arg: file});
      assert.strictEqual(toolOutput(r).outcome, 'blocked', `${file}: ${JSON.stringify(r)}`);
    }
  });

  it('refuses a module outside --modulePath', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened', '--authoringTools',
      '--modulePath', root]);
    const r = await mcpCall(9614, KEY, 'countinghouse_load_module',
      {path: path.join(ROOT, 'test', 'fixtures', 'handler-map-convention'), name: 'handler-map-convention', version: '1.0.0'});
    assert.strictEqual(toolErrorCode(r), 'MODULE_PATH_OUTSIDE_ROOT', JSON.stringify(r));
  });

  it('refuses a module outside --modulePath on restart, reload, and through a symlink', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened', '--authoringTools',
      '--modulePath', root, '--loadModule', path.join(root, 'sandbox-probe')]);
    const outside = path.join(ROOT, 'test', 'fixtures', 'sandbox-probe');
    fs.symlinkSync(outside, path.join(root, 'linked-probe'));
    const restart = await post(9614, KEY, '/restart-module', {path: outside, name: 'sandbox-probe', version: '1.0.0'});
    assert.ok(JSON.stringify(restart.body).includes('MODULE_PATH_OUTSIDE_ROOT'), JSON.stringify(restart));
    const reload = await post(9614, KEY, '/reload-module', {path: outside});
    assert.ok(JSON.stringify(reload.body).includes('MODULE_PATH_OUTSIDE_ROOT'), JSON.stringify(reload));
    const linked = await mcpCall(9614, KEY, 'countinghouse_load_module',
      {path: path.join(root, 'linked-probe'), name: 'sandbox-probe', version: '1.0.0'});
    assert.strictEqual(toolErrorCode(linked), 'MODULE_PATH_OUTSIDE_ROOT', JSON.stringify(linked));
    // The running module was left alone by all three.
    const r = await mcpCall(9614, KEY, 'sandbox_probe_probeservice_env', {});
    assert.strictEqual(r.isError, false, JSON.stringify(r));
  });

  // Review Focus 5.
  it('accepts a relative --loadModule path that resolves inside --modulePath', async () => {
    server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened',
      '--modulePath', root, '--loadModule', path.relative(ROOT, path.join(root, 'sandbox-probe'))]);
    const r = await mcpCall(9614, KEY, 'sandbox_probe_probeservice_env', {});
    assert.strictEqual(r.isError, false, JSON.stringify(r));
  });

  // The default file auth provider reads ./auth.json, and writes it with a
  // demo key on first run; neither may be blocked by the permission model.
  it('starts with the default file auth, first run and after', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hardened-cwd-'));
    try {
      for (const run of ['first', 'second']) {
        server = await startServer(9614, ['--workerThread', '--hardened', '--modulePath', root], {cwd: cwd});
        assert.ok(fs.existsSync(path.join(cwd, 'auth.json')), `${run} run: ${server.output.slice(-2000)}`);
        stopServer(server);
        server = null;
      }
    } finally {
      fs.rmSync(cwd, {recursive: true, force: true});
    }
  });

  // CHUtil's HTTP library loads on first use (lib/lazy-require.js),
  // so its files are read after the permission model is live, not in the
  // worker's boot (reviewer, 2026-11-12). The fixture declares 127.0.0.1 and a
  // policy approves it; the stand-in is an ephemeral loopback server.
  it('the first CHUtil.request works under --hardened, loading its library only then', async () => {
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'lazy-net-probe'), path.join(root, 'lazy-net-probe'), {recursive: true});
    const policy = path.join(root, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({modules: {'lazy-net-probe': {approve: 'as-declared'}}}));
    const standIn = await startStandIn();
    try {
      server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened', '--moduleSandbox', 'enforce',
        '--modulePolicy', policy, '--modulePath', root, '--loadModule', path.join(root, 'lazy-net-probe')]);
      const probe = async (args) => toolOutput(await mcpCall(9614, KEY, 'lazy_net_probe_netservice_probe', args));
      assert.deepStrictEqual((await probe({what: 'loaded'})).loaded, {request: false});
      const r = await probe({what: 'request', url: `${standIn.base}/`});
      assert.deepStrictEqual([r.outcome, r.status, r.body, r.loaded], ['ok', 200, 'ok', {request: true}], JSON.stringify(r));
    } finally {
      await standIn.close();
    }
  });

  // The broker under the permission model: a module writes and reads /data.
  // --moduleDataPath is a sibling of the install dir whose name extends it
  // (<repo>_data-…), the grant layout that tripped Node 24's prefix bug
  // (test/fs-broker/10-permission-prefix.js) with the default under $HOME.
  it('a module writes and reads /data under --hardened', async () => {
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), path.join(root, 'fs-probe'), {recursive: true});
    const data = `${fs.realpathSync(ROOT)}_data-${process.pid}`;
    try {
      server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened',
        '--modulePath', root, '--moduleDataPath', data, '--loadModule', path.join(root, 'fs-probe')]);
      const w = await mcpCall(9614, KEY, 'fs_probe_probeservice_write', {path: '/data/x', content: 'hardened'});
      assert.deepStrictEqual(toolOutput(w), {ok: true, code: null}, JSON.stringify(w));
      const r = await mcpCall(9614, KEY, 'fs_probe_probeservice_read', {path: '/data/x'});
      assert.deepStrictEqual(toolOutput(r), {content: 'hardened', code: null});
      assert.strictEqual(fs.readFileSync(path.join(data, 'fs-probe', 'data', 'x'), 'utf8'), 'hardened');
    } finally {
      fs.rmSync(data, {recursive: true, force: true});
    }
  });

  // Load, restart and file I/O under --hardened with enforce live: every
  // main-thread and worker path, with the loader's grants acting on files
  // inside the grant roots, never on a root itself (plan 3, Task 4).
  it('a module restarts and still reads /data under --hardened (enforce)', async () => {
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'fs-probe'), path.join(root, 'fs-probe'), {recursive: true});
    const data = `${fs.realpathSync(ROOT)}_data-${process.pid}`;
    try {
      server = await startServer(9614, ['--debug', '--debugKey', KEY, '--workerThread', '--hardened', '--moduleSandbox', 'enforce',
        '--modulePath', root, '--moduleDataPath', data, '--loadModule', path.join(root, 'fs-probe')]);
      await mcpCall(9614, KEY, 'fs_probe_probeservice_write', {path: '/data/x', content: 'kept'});
      const restarted = await post(9614, KEY, '/restart-module', {name: 'fs-probe'});
      assert.strictEqual(restarted.status, 200, JSON.stringify(restarted.body));
      await waitFor(async () => {
        const r = await mcpCall(9614, KEY, 'fs_probe_probeservice_read', {path: '/data/x'});
        return r.isError === false && toolOutput(r).content === 'kept';
      }, 15000, 'read after restart');
      const where = await mcpCall(9614, KEY, 'fs_probe_probeservice_where', {});
      assert.strictEqual(toolOutput(where).dirname, '/app/handlers/probeService', JSON.stringify(where));
    } finally {
      fs.rmSync(data, {recursive: true, force: true});
    }
  });

  it('needs --workerThread', async () => {
    server = await startServer(9614, ['--no-workerThread', '--debug', '--hardened', '--modulePath', root], {expectExit: true});
    assert.strictEqual(server.exitCode, 2);
    assert.ok(server.output.includes('--hardened needs --workerThread'), server.output);
  });
});

// L1: the descriptor routes under --hardened, one server for all of them.
describe('sandbox 09: --hardened descriptor routes', function() {
  this.timeout(90000);
  let server = null;
  let root = null;
  before(async () => { root = moduleRoot(); server = await startFdProbe(root); });
  after(() => { stopServer(server); fs.rmSync(root, {recursive: true, force: true}); });

  // L1: a descriptor given to net.Socket, as the fd option and as Node's
  // bare-number form. Under the permission model the native open(fd)
  // backstop cannot be taken from the bindings, so the entry points' checks
  // and the prototypes taken from instances (test/sandbox/36) are the guards.
  it('refuses a descriptor given to net.Socket, as an option and as a bare number', async () => {
    for (const form of ['option', 'number']) {
      assert.deepStrictEqual(await fdAttempt(form), {outcome: 'blocked', code: 'ERR_ACCESS_DENIED'}, form);
    }
  });

  // Review of #36: the check reads the options once, so an fd getter that
  // answers undefined to the check cannot answer a number to Node.
  it('reads an fd getter once: what the check saw is what Node gets', async () => {
    assert.deepStrictEqual(await fdAttempt('getter'), {outcome: 'not adopted', reads: 1});
  });

  // Review of #36: net.connect and createConnection build Node's internal
  // Socket, not the exported one, so the net.Socket guard never saw them
  // (the reviewer's probe on Node 24: zero hits). A module could guess the
  // main server's listening fd and "connect" with it; the failed connect's
  // destroy then closes the main thread's socket. http.request reaches the
  // same route through the agent's net.createConnection.
  it('refuses a descriptor given to net.connect, net.createConnection and http.request', async () => {
    for (const form of ['connect', 'createConnection', 'request']) {
      assert.deepStrictEqual(await fdAttempt(form), {outcome: 'blocked', code: 'ERR_ACCESS_DENIED'}, form);
    }
  });

  // Review of #36, round 2: Node reads an array that is not its own
  // normalised [options, cb] as an object of its own properties, so an
  // array with an fd property adopts it (on plain Node, new net.Socket(a)
  // reaches ERR_INVALID_FD_TYPE). The check reads it the same way.
  it('refuses a descriptor given as an array\'s fd property to net.Socket, net.connect and listen', async () => {
    for (const form of ['arraySocket', 'arrayConnect', 'arrayListen']) {
      assert.deepStrictEqual(await fdAttempt(form), {outcome: 'blocked', code: 'ERR_ACCESS_DENIED'}, form);
    }
  });

  // L1 round 4: the guards are Proxies, and a Proxy's prototype is its
  // target's, so prototype.constructor was the real constructor; tty builds
  // its handle from the fd with no open(fd), so no backstop saw it. A
  // subclass's [[Prototype]] is the constructor it extends: the real
  // net.Socket, behind tty's streams and TLSSocket.
  it('refuses a descriptor given to the constructors behind net.Socket and tty', async () => {
    for (const form of ['socketCtor', 'ttyWriteCtor', 'ttyReadCtor', 'ttySuper', 'tlsSuper']) {
      assert.deepStrictEqual(await fdAttempt(form), {outcome: 'blocked', code: 'ERR_ACCESS_DENIED'}, form);
    }
  });

  // Review of #36 (F1): a handle the module builds from an instance's
  // constructor; before this release its open(fd) was not guarded under
  // --hardened.
  it('refuses open(fd) on a TCP, a Pipe and a UDP handle the module builds', async () => {
    for (const form of ['tcpOpen', 'pipeOpen', 'udpOpen']) {
      assert.deepStrictEqual(await fdAttempt(form), {outcome: 'blocked', code: 'ERR_ACCESS_DENIED'}, form);
    }
  });
});
