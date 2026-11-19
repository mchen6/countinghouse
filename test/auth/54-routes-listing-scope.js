'use strict';
// The HTTP spec and schema routes answer only the caller's listing (the
// reviewer's rulings, 2026-11-19, on #400's follow-up), end to end on a real
// server with the file provider: for each key and each loaded module,
// get-spec and the schema route answer exactly when that key's tools/list
// shows the module's tools; otherwise they refuse it whole. Covered here: a
// module outside the key's grants, and an unlisted part (asks-part, loaded
// under --partDir because the asks-through-part scenario calls it). The
// single-identity profile and a module hidden while it goes on or off are
// mcp-contract 38's (unit).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const request = require('supertest');
const waitForReady = require('../helpers/wait-for-ready');
const {testPort, redisFlag, startShell, stopAll} = require('../helpers/test-env');
const {deviceIDForName} = require('../../lib/call-address');
const {toolNameFor} = require('../../lib/mcp/tool-name');

const PORT = testPort(9794);
const url = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..', '..');
const DIRS = {
  echo: path.join(ROOT, 'pre-installed-packages', 'echo-device-module'),
  transform: path.join(ROOT, 'pre-installed-packages', 'transform-demo'),
  scenario: path.join(ROOT, 'test', 'fixtures', 'asks-through-part'),
  part: path.join(ROOT, 'test', 'fixtures', 'asks-part')
};
const api = (m) => require(path.join(DIRS[m], 'api.json'));
const role = (m) => ((require(path.join(DIRS[m], 'package.json')).countinghouse || {}).role || null);
const idOf = (m) => deviceIDForName(api(m).device.friendlyName);
// the names tools/list gives a module's described actions (lib/mcp/tool-name.js)
const toolNames = (m) => Object.entries(api(m).device.serviceList).flatMap(([urn, s]) => (s.actionList || [])
  .filter((a) => typeof a.description === 'string').map((a) => toolNameFor(role(m), api(m).device.friendlyName, urn, a.name)));

const WILDCARD_KEY = `wild-${'w'.repeat(24)}`;
const SCOPED_KEY = `scoped-${'s'.repeat(24)}`;

describe('auth 54: get-spec and the schema route answer only what the caller\'s tools/list shows', function() {
  this.timeout(0);
  let dir;

  before((done) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-auth-54-'));
    const auth = path.join(dir, 'auth.json');
    // the scoped key is granted echo-device only; the scenario has its own
    // identity, granted what it calls (as auth 12 and docs/composite-tools.md give one)
    fs.writeFileSync(auth, JSON.stringify({
      [WILDCARD_KEY]: {userName: 'wild', devices: ['*']},
      [SCOPED_KEY]: {userName: 'scoped', devices: [idOf('echo')]},
      [`scenario-${'i'.repeat(24)}`]: {userName: 'asks-through-part-identity', devices: ['*'], runsModules: ['asks-through-part']}
    }));
    waitForReady(startShell(`"./bin/countinghouse"${redisFlag()} --workerThread --bindAddr 127.0.0.1 --port ${PORT} --authProvider file --authConfigPath ${auth}`
      + ` --modulesRoot ${ROOT} --loadModule ${DIRS.echo} --loadModule ${DIRS.transform} --loadModule ${DIRS.scenario} --partDir ${DIRS.part}`,
    (err) => { if (err) console.log(err); }), done);
  });

  after((done) => { fs.rmSync(dir, {recursive: true, force: true}); stopAll(done); });

  const toolsList = (key) => new Promise((resolve, reject) => request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', key)
    .send({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})
    .end((err, res) => (err ? reject(err) : resolve(res.body.result.tools.map((t) => t.name)))));
  const get = (key, p) => new Promise((resolve, reject) => request(url).get(p).set('X-CH-Key', key).end((err, res) => (err ? reject(err) : resolve(res))));

  it('the setting is as meant: the scenario, echo-device and transform-demo listed; the part loaded but not listed', async () => {
    const tools = await toolsList(WILDCARD_KEY);
    for (const m of ['scenario', 'echo', 'transform']) assert.ok(toolNames(m).some((n) => tools.includes(n)), `${m}: ${JSON.stringify(tools)}`);
    assert.ok(!toolNames('part').some((n) => tools.includes(n)), 'the part is not listed');
    // the part is loaded: the runtime knows its device (its invoke answers
    // MODULE_NOT_LISTED, as #400 left it, never DEVICE_NOT_FOUND)
    const res = await new Promise((resolve, reject) => request(url).post(`/devices/${idOf('part')}/invoke-action`).set('X-CH-Key', WILDCARD_KEY)
      .send({serviceID: 'urn:x', actionName: 'x', input: {}}).end((err, r) => (err ? reject(err) : resolve(r))));
    assert.notStrictEqual(res.body.code, 'DEVICE_NOT_FOUND', JSON.stringify(res.body));
  });

  for (const key of [WILDCARD_KEY, SCOPED_KEY]) {
    it(`${key === WILDCARD_KEY ? 'a key granted every device' : 'a key granted one device'}: each route answers a module exactly when tools/list shows it`, async () => {
      const tools = await toolsList(key);
      for (const m of Object.keys(DIRS)) {
        const shown = toolNames(m).some((n) => tools.includes(n));
        for (const p of [`/devices/${idOf(m)}/get-spec`, `/devices/${idOf(m)}/schema/`]) {
          const res = await get(key, p);
          if (shown) {
            assert.strictEqual(res.status, 200, `${key} ${m} ${p}: ${JSON.stringify(res.body).slice(0, 300)}`);
          } else {
            assert.notStrictEqual(res.status, 200, `${key} ${m} ${p} answered: ${JSON.stringify(res.body).slice(0, 300)}`);
            assert.ok(['MODULE_NOT_LISTED', 'USER_HAS_NO_DEVICE'].includes(res.body.code), `${key} ${m} ${p}: ${JSON.stringify(res.body)}`);
          }
        }
      }
    });
  }

  it('the unlisted part is refused MODULE_NOT_LISTED by both routes, even to a key granted every device', async () => {
    for (const p of [`/devices/${idOf('part')}/get-spec`, `/devices/${idOf('part')}/schema/`]) {
      const res = await get(WILDCARD_KEY, p);
      assert.strictEqual(res.body.code, 'MODULE_NOT_LISTED', `${p}: ${JSON.stringify(res.body)}`);
    }
  });
});
