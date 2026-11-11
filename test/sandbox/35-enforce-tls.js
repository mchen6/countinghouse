// L1: TLS client connections under enforce. A TLSSocket hands net.Socket the
// handle Node just made; the lockdown's descriptor backstop used to read a
// handle object as adoption, so under enforce a module could make no TLS
// connection at all (tls.connect, https, fetch), while the documented rule
// until the network broker is that no network permission is enforced in any
// mode. Here a module reaches a local self-signed TLS server by all three
// routes under enforce, under --hardened enforce (where the lockdown cannot
// consult Node's bindings) and under audit, and no violation is logged.
// The certificate comes from openssl; a machine without it fails here
// rather than skipping, so a CI image without openssl gives a signal.
const assert = require('assert');
const fs     = require('fs');
const https  = require('https');
const os     = require('os');
const path   = require('path');
const {spawnSync} = require('child_process');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

const KEY     = 'aabbcc';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'tls-probe');
const NAME    = 'tls-probe';
const tool    = (a) => `tls_probe_probeservice_${a.toLowerCase()}`;

// A certificate for 127.0.0.1 from openssl, trusted by the server process
// (and so by its workers) through NODE_EXTRA_CA_CERTS.
function makeCert(dir) {
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], {encoding: 'utf8', timeout: 20000});
  assert.strictEqual(r.status, 0, `openssl is needed to make the test certificate: ${r.error ? r.error.message : r.stderr}`);
}

// --hardened: the module must live under --modulePath, and the certificate
// is placed there too, inside the directories the child may read.
function hardenedRoot(dir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tls-hardened-'));
  fs.cpSync(FIXTURE, path.join(root, NAME), {recursive: true});
  fs.copyFileSync(path.join(dir, 'cert.pem'), path.join(root, 'cert.pem'));
  return root;
}

const ROWS = [
  ['enforce', 9683, (dir) => ({args: ['--moduleSandbox', 'enforce', '--loadModule', FIXTURE], cert: path.join(dir, 'cert.pem')})],
  ['hardened enforce', 9685, (dir) => {
    const root = hardenedRoot(dir);
    return {args: ['--hardened', '--moduleSandbox', 'enforce', '--modulePath', root, '--loadModule', path.join(root, NAME)],
      cert: path.join(root, 'cert.pem'), root: root};
  }],
  ['audit', 9684, (dir) => ({args: ['--moduleSandbox', 'audit', '--loadModule', FIXTURE], cert: path.join(dir, 'cert.pem')})]
];

describe('sandbox 35: TLS client connections under enforce', function() {
  this.timeout(120000);
  let dir = null;
  let tlsServer = null;
  let tlsPort = 0;

  before((done) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tls-probe-'));
    makeCert(dir);
    tlsServer = https.createServer({key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem'))},
      (req, res) => res.end('hello'));
    tlsServer.listen(0, '127.0.0.1', () => { tlsPort = tlsServer.address().port; done(); });
  });
  after((done) => {
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    if (tlsServer == null) return done();
    tlsServer.closeAllConnections();
    tlsServer.close(() => done());
  });

  ROWS.forEach(([mode, port, launch]) => {
    describe(mode, () => {
      let server = null;
      let world = null;
      const call = (a) => mcpCall(port, KEY, tool(a), {port: tlsPort}).then(toolOutput);
      before(async () => {
        world = launch(dir);
        server = await startServer(port, ['--debug', '--debugKey', KEY, '--workerThread'].concat(world.args),
          {env: {NODE_EXTRA_CA_CERTS: world.cert}});
      });
      after(() => {
        stopServer(server);
        if (world != null && world.root != null) fs.rmSync(world.root, {recursive: true, force: true});
      });

      it('tls.connect completes a round trip to a local TLS server', async () => {
        assert.deepStrictEqual(await call('tlsRoundTrip'), {code: 'round-trip', authorized: true, body: 'hello'});
      });

      it('https.get completes', async () => {
        assert.deepStrictEqual(await call('httpsGet'), {code: 'status', status: 200, body: 'hello'});
      });

      it('fetch over https completes', async () => {
        assert.deepStrictEqual(await call('fetchGet'), {code: 'ok', status: 200, body: 'hello'});
      });

      it('the three connections tripped no violation', async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));   // the log reaches the test asynchronously
        assert.ok(!server.output.includes(`module sandbox: ${NAME} violation`),
          server.output.split('\n').filter((l) => l.includes('module sandbox')).join('\n'));
      });
    });
  });
});
