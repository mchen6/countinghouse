// A reload refused for an invalid version string unloads the module, and
// under --workerThread that means its worker too: the devices answer
// MODULE_UNLOADED, nothing is left running under the name (so uninstall is
// not refused MODULE_LOADED), and fixing the version and loading again works.
// It used to purge the main thread's records only, leaving the worker
// running with no way to reach it.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, post, waitFor} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');
const {testPort} = require('../helpers/test-env');

const PORT    = testPort(9632);
const KEY     = 'failed-reload-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'worker-end');
const DEVICE  = deviceIDForName('worker-end');
const SERVICE = 'urn:countinghouse-test:serviceID:endService';

const invoke = () => post(PORT, KEY, `/devices/${DEVICE}/invoke-action`, {serviceID: SERVICE, actionName: 'ping', input: {}});
const codeOf = (r) => (r.body != null ? r.body.code : undefined);

describe('module-loading 16: a reload refused for its version ends the worker', function() {
  this.timeout(120000);
  let server = null;
  let base = null;
  let copy = null;
  const setVersion = (v) => {
    const file = path.join(copy, 'package.json');
    fs.writeFileSync(file, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(file, 'utf8')), {version: v}), null, 2));
  };

  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-failed-reload-'));
    copy = path.join(base, 'worker-end');
    fs.cpSync(FIXTURE, copy, {recursive: true});
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleDataPath', path.join(base, 'store')]);
    await post(PORT, KEY, '/load-module', {path: copy, name: 'worker-end'});
    await waitFor(async () => (await invoke()).status === 200, 20000, 'worker-end to answer');
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('the reload is refused MODULE_VERSION_INFO_INVALID', async () => {
    setVersion('1.0');
    const r = await post(PORT, KEY, '/reload-module', {path: copy});
    assert.strictEqual(codeOf(r), 'MODULE_VERSION_INFO_INVALID', JSON.stringify(r.body));
  });

  it('its device answers MODULE_UNLOADED', async () => {
    let last = null;
    await waitFor(async () => { last = await invoke(); return codeOf(last) === 'MODULE_UNLOADED'; }, 5000,
      'MODULE_UNLOADED').catch(() => assert.fail(`last answer: ${JSON.stringify(last && last.body)}`));
  });

  it('nothing is left running under the name: uninstall is not refused MODULE_LOADED', async () => {
    let last = null;
    await waitFor(async () => { last = await post(PORT, KEY, '/uninstall-module', {name: 'worker-end', keepData: true}); return codeOf(last) !== 'MODULE_LOADED'; },
      5000, 'uninstall').catch(() => assert.fail(`last answer: ${JSON.stringify(last && last.body)}`));
    assert.strictEqual(last.status, 200, JSON.stringify(last.body));
  });

  it('with the version fixed, it loads and answers again', async () => {
    setVersion('1.0.1');
    await post(PORT, KEY, '/load-module', {path: copy, name: 'worker-end'});
    await waitFor(async () => (await invoke()).status === 200, 20000, 'worker-end to answer again');
  });
});
