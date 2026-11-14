// A composition hop to a device that is not loaded answers why (MODULE_
// UNLOADED, MODULE_RESTARTING, ..., or DEVICE_NOT_FOUND for one never hosted)
// only to an identity granted that device. Any other identity gets
// USER_HAS_NO_DEVICE in every case, as over HTTP; otherwise the answer would
// tell it whether a device was ever hosted here. Both hop paths: a direct
// peer channel and the main thread.
//
// A hop's client is built by asking main for the device's spec. That query
// carries the call's token and the identity named (R2-1 Task 3), so main
// can run the access check: an identity granted the device is told why it
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
const ADMIN     = 'hop-oracle-admin';
const GRANTED   = 'hop-oracle-granted';
const UNGRANTED = 'hop-oracle-ungranted';
// Used only after the unload, so their clients are built then (clients are
// cached per identity).
const GRANTED_FRESH   = 'hop-oracle-granted-fresh';
const UNGRANTED_FRESH = 'hop-oracle-ungranted-fresh';
const PROBE = 'hop_prober_probeservice_probe';
// The device ID in a message is the caller's own input, not a disclosure.
const normalised = (seen) => ({code: seen.code, message: String(seen.message).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')});

[{label: 'over a direct peer channel', port: 9616, flags: []},
  {label: 'through the main thread', port: 9617, flags: ['--no-directPeerChannels']}].forEach((variant) => {
  describe(`composition 16: a hop to a missing device, ${variant.label}`, function() {
    this.timeout(90000);
    let base = null;
    let server = null;
    const probe = (as, deviceID) => mcpCall(variant.port, ADMIN, PROBE, {as: as, deviceID: deviceID});
    const observe = async (as, deviceID) => {
      const r = await mcpCall(variant.port, ADMIN, 'hop_prober_probeservice_observe', {as: as, deviceID: deviceID});
      return JSON.parse(r.content[0].text);
    };

    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-hop-oracle-'));
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({
        [ADMIN]: {userName: 'admin', devices: ['*'], admin: true, runsModules: ['hop-prober']},
        [GRANTED]: {userName: 'granted', devices: [DEVICE, NEVER]},
        [UNGRANTED]: {userName: 'ungranted', devices: [deviceIDForName('some-other-module')]},
        [GRANTED_FRESH]: {userName: 'granted-fresh', devices: [DEVICE, NEVER]},
        [UNGRANTED_FRESH]: {userName: 'ungranted-fresh', devices: [deviceIDForName('some-other-module')]}
      }));
      server = await startServer(variant.port, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath,
        '--loadModule', INNER, '--loadModule', PROBER].concat(variant.flags));
      await waitFor(async () => (await probe(GRANTED, DEVICE)).isError === false, 20000, 'the probe to reach worker-end');
      // Both identities build their client while the device is loaded.
      await probe(UNGRANTED, DEVICE);
      assert.strictEqual((await post(variant.port, ADMIN, '/unload-module', {name: 'worker-end'})).status, 200);
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('through a client built while it was loaded: MODULE_UNLOADED to an identity granted it', async () => {
      const r = await probe(GRANTED, DEVICE);
      assert.strictEqual(toolErrorCode(r), 'MODULE_UNLOADED', JSON.stringify(r));
    });

    it('through a client built while it was loaded: USER_HAS_NO_DEVICE to an identity without a grant', async () => {
      const r = await probe(UNGRANTED, DEVICE);
      assert.strictEqual(toolErrorCode(r), 'USER_HAS_NO_DEVICE', JSON.stringify(r));
    });

    it('a client built now: the identity granted the declared device is told why it is missing (R2-1 Task 3)', async () => {
      const unloaded = await observe(GRANTED_FRESH, DEVICE);
      assert.strictEqual(unloaded.code, 'MODULE_UNLOADED', JSON.stringify(unloaded));
    });

    it('a client built now: an identity without a grant gets the access error for the declared device', async () => {
      const unloaded = await observe(UNGRANTED_FRESH, DEVICE);
      assert.strictEqual(unloaded.code, 'USER_HAS_NO_DEVICE', JSON.stringify(unloaded));
    });

    it('a client built now, for a device never hosted: refused as undeclared, the same as a present device not declared (#148)', async () => {
      const present = deviceIDForName('hop-prober');   // loaded, and not among its own declarations
      for (const as of [GRANTED_FRESH, UNGRANTED_FRESH]) {
        const never = await observe(as, NEVER);
        assert.strictEqual(never.code, 'CTX_CALL_UNDECLARED', JSON.stringify(never));
        assert.deepStrictEqual(normalised(never), normalised(await observe(as, present)), JSON.stringify(never));
      }
    });
  });
});
