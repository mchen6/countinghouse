// A supervised module whose restarted worker crashes again before its
// devices are back online keeps what it had: its tools stay listed while it
// restarts and once it is suspended, and its device answers what the
// supervisor says -- MODULE_SUSPENDED after the third exit, not
// MODULE_RESTARTING. The restarted worker's own device list is empty until
// discovery, and it used to replace the specs the supervisor had kept.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, post, waitFor} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const PORT   = 9638;
const KEY    = 'crash-in-discovery-key';
const DEVICE = deviceIDForName('stray-output-module');
const call   = (v) => post(PORT, KEY, `/devices/${DEVICE}/invoke-action`,
  {serviceID: 'urn:countinghouse-test:serviceID:svc', actionName: 'returnsCleanly', input: {v: v}});
const codeOf = (r) => (r.status === 200 ? 200 : (r.body != null ? r.body.code : undefined));
const tools  = () => request(`http://127.0.0.1:${PORT}`).post('/mcp').set('X-CH-Key', KEY)
  .set('Accept', 'application/json, text/event-stream').send({jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {}})
  .then((r) => r.body.result.tools.map((t) => t.name).filter((n) => n.startsWith('stray_output_module_')).sort());

describe('sandbox 28: a crash during a restarted worker\'s discovery', function() {
  this.timeout(90000);
  let server = null;
  let base = null;
  before(async () => {
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread']);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('keeps the module\'s tools listed and its device answering MODULE_SUSPENDED', async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-crash-in-discovery-'));
    const dir = path.join(base, 'stray-output-module');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'stray-output-module'), dir, {recursive: true});
    const marker = path.join(dir, 'crash-in-discovery');
    // Once the marker exists, every worker crashes 500 ms into discovery,
    // before its device would come online (at 3 s).
    const index = path.join(dir, 'index.js');
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace("this.emit('deviceonline', new Device(), this);",
      "if (require('fs').existsSync(`${__dirname}/crash-in-discovery`)) {\n" +
      "    setTimeout(() => process.exit(3), 500);\n" +
      "    setTimeout(() => this.emit('deviceonline', new Device(), this), 3000);\n" +
      "  } else this.emit('deviceonline', new Device(), this);"));
    const device = path.join(dir, 'device.js');
    fs.writeFileSync(device, fs.readFileSync(device, 'utf8').replace("this.setAction('urn:countinghouse-test:serviceID:svc', 'returnsCleanly', (args, callback) => {",
      "this.setAction('urn:countinghouse-test:serviceID:svc', 'returnsCleanly', (args, callback) => {\n    if (args.input.v === 'crash') { setTimeout(() => process.exit(3), 50); return callback(null, {output: {v: 'bye'}}); }"));

    await post(PORT, KEY, '/load-module', {path: dir, name: 'stray-output-module'});
    await waitFor(async () => (await call('x')).status === 200, 20000, 'the module to answer');
    const listed = await tools();
    assert.ok(listed.length > 0, 'no tools listed before the crash');

    fs.writeFileSync(marker, '');
    await call('crash');
    // Exit 1 (the crash), then 2 and 3 in the restarted workers' discovery.
    const mark = server.output.length;
    await waitFor(() => /suspended after repeated exits/.test(server.output.slice(mark)), 30000, 'the module to be suspended');
    const after = await call('x');
    assert.strictEqual(codeOf(after), 'MODULE_SUSPENDED', JSON.stringify(after.body));
    assert.deepStrictEqual(await tools(), listed, 'the suspended module\'s tools are no longer listed');
  });
});
