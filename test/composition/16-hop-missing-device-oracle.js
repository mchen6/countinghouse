// A composition hop to a device that is not loaded answers why (MODULE_
// UNLOADED, MODULE_RESTARTING, ..., or DEVICE_NOT_FOUND for one never hosted)
// only to an identity granted that device. Any other identity gets
// USER_HAS_NO_DEVICE in every case, as over HTTP; otherwise the answer would
// tell it whether a device was ever hosted here. Both hop paths: a direct
// peer channel and the main thread; a client cached before the unload and
// one built after it. An identity without the grant is the bound one after
// its grant is withdrawn (a binding without it fails verification at load).
//
// A hop's client is built by asking main for the device's spec. That query
// carries the call's token, whose identity is the module's binding (R2-1
// Tasks 3 and 5), so main can run the access check: an identity granted the device is told why it
// is missing, any other gets the access error. And the query answers only
// for a device the module declared calls on (R2-1 Task 5, #148): a device
// never hosted cannot be among its declarations (verification would have
// failed), so it is refused CTX_CALL_UNDECLARED, the same answer a present
// device it did not declare gets.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {toolErrorCode} = require('../helpers/tool-result');
const {deviceIDForName} = require('../../lib/call-address');

const INNER  = path.join(ROOT, 'test', 'fixtures', 'worker-end');
const PROBER = path.join(ROOT, 'test', 'fixtures', 'hop-prober');
const DEVICE = deviceIDForName('worker-end');
const NEVER  = deviceIDForName('never-loaded-anywhere');
const ADMIN = 'hop-oracle-admin';
// The prober's hops authorize as its binding (R2-1 Task 5: no `as`): this
// identity, granted worker-end until a case withdraws the grant.
const BOUND = 'hop-oracle-bound';
const PROBE = 'hop_prober_probeservice_probe';
// The device ID in a message is the caller's own input, not a disclosure.
const normalised = (seen) => ({code: seen.code, message: String(seen.message).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')});

const authFor = (granted) => JSON.stringify({
  [ADMIN]: {userName: 'admin', devices: ['*'], admin: true},
  [BOUND]: {userName: 'bound', devices: granted ? [DEVICE] : [deviceIDForName('some-other-module')], runsModules: ['hop-prober']}
});

[{label: 'over a direct peer channel', port: 9616, flags: []},
  {label: 'through the main thread', port: 9617, flags: ['--no-directPeerChannels']}].forEach((variant) => {
  [{when: 'cached before the unload', hopFirst: true}, {when: 'built after the unload', hopFirst: false}].forEach(({when, hopFirst}) => {
    describe(`composition 16: a hop to a missing device, ${variant.label}, its client ${when}`, function() {
      this.timeout(90000);
      let base = null;
      let server = null;
      let authPath = null;
      const probe = (deviceID) => mcpCall(variant.port, ADMIN, PROBE, {deviceID: deviceID});
      const observe = async (deviceID) => JSON.parse((await mcpCall(variant.port, ADMIN, 'hop_prober_probeservice_observe', {deviceID: deviceID})).content[0].text);

      before(async () => {
        base = fs.mkdtempSync(path.join(os.homedir(), '.ch-hop-oracle-'));
        authPath = path.join(base, 'auth.json');
        fs.writeFileSync(authPath, authFor(true));
        server = await startServer(variant.port, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath,
          '--loadModule', INNER, '--loadModule', PROBER].concat(variant.flags));
        // the client cached while the device is loaded, or no hop at all
        // until it is gone, so the first is built through the device query
        if (hopFirst) await waitFor(async () => (await probe(DEVICE)).isError === false, 20000, 'the probe to reach worker-end');
        assert.strictEqual((await post(variant.port, ADMIN, '/unload-module', {name: 'worker-end'})).status, 200);
      });
      after(() => {
        stopServer(server);
        if (base != null) fs.rmSync(base, {recursive: true, force: true});
      });

      it('the identity granted the device is told why it is missing: MODULE_UNLOADED', async () => {
        assert.strictEqual(toolErrorCode(await probe(DEVICE)), 'MODULE_UNLOADED');
        assert.strictEqual((await observe(DEVICE)).code, 'MODULE_UNLOADED');
      });

      it('a device never hosted is refused as undeclared, the same as a present device not declared (#148)', async () => {
        const never = await observe(NEVER);
        assert.strictEqual(never.code, 'CTX_CALL_UNDECLARED', JSON.stringify(never));
        assert.deepStrictEqual(normalised(never), normalised(await observe(deviceIDForName('hop-prober'))), JSON.stringify(never));
      });

      // last: the grant is withdrawn (POST /reload-auth); the identity then
      // gets the access error, and so learns nothing about the device
      it('once its grant is withdrawn, the identity gets the access error: USER_HAS_NO_DEVICE', async () => {
        fs.writeFileSync(authPath, authFor(false));
        assert.strictEqual((await post(variant.port, ADMIN, '/reload-auth', {})).status, 200);
        assert.strictEqual(toolErrorCode(await probe(DEVICE)), 'USER_HAS_NO_DEVICE');
        assert.strictEqual((await observe(DEVICE)).code, 'USER_HAS_NO_DEVICE');
      });
    });
  });
});
