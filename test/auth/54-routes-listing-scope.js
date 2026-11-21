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
const {toolNameFor, promptNameFor, slugify} = require('../../lib/mcp/tool-name');

const PORT = testPort(9794);
const url = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..', '..');
const DIRS = {
  echo: path.join(ROOT, 'pre-installed-packages', 'echo-device-module'),
  transform: path.join(ROOT, 'pre-installed-packages', 'transform-demo'),
  scenario: path.join(ROOT, 'test', 'fixtures', 'asks-through-part'),
  part: path.join(ROOT, 'test', 'fixtures', 'asks-part'),
  // (prompts and resources: the one module here that declares them)
  everything: path.join(ROOT, 'test', 'fixtures', 'declares-everything')
};
const api = (m) => require(path.join(DIRS[m], 'api.json'));
const role = (m) => ((require(path.join(DIRS[m], 'package.json')).countinghouse || {}).role || null);
const idOf = (m) => deviceIDForName(api(m).device.friendlyName);
// the names tools/list gives a module's described actions (lib/mcp/tool-name.js)
const toolNames = (m) => Object.entries(api(m).device.serviceList).flatMap(([urn, s]) => (s.actionList || [])
  .filter((a) => typeof a.description === 'string').map((a) => toolNameFor(role(m), api(m).device.friendlyName, urn, a.name)));

const WILDCARD_KEY = `wild-${'w'.repeat(24)}`;
const SCOPED_KEY = `scoped-${'s'.repeat(24)}`;
// granted the module with prompts and resources, and one other
const OTHER_KEY = `other-${'o'.repeat(24)}`;

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
      [OTHER_KEY]: {userName: 'other', devices: [idOf('transform'), idOf('everything')]},
      [`scenario-${'i'.repeat(24)}`]: {userName: 'asks-through-part-identity', devices: ['*'], runsModules: ['asks-through-part']}
    }), {mode: 0o600});
    waitForReady(startShell(`"./bin/countinghouse"${redisFlag()} --workerThread --bindAddr 127.0.0.1 --port ${PORT} --authProvider file --authConfigPath ${auth}`
      + ` --modulesRoot ${ROOT} --loadModule ${DIRS.echo} --loadModule ${DIRS.transform} --loadModule ${DIRS.scenario} --partDir ${DIRS.part}`
      + ` --loadModule ${DIRS.everything}`,
    (err) => { if (err) console.log(err); }), done);
  });

  after((done) => { fs.rmSync(dir, {recursive: true, force: true}); stopAll(done); });

  const mcp = (key, method) => new Promise((resolve, reject) => request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', key)
    .send({jsonrpc: '2.0', id: 1, method, params: {}})
    .end((err, res) => (err ? reject(err) : resolve(res.body.result))));
  const toolsList = async (key) => (await mcp(key, 'tools/list')).tools.map((t) => t.name);
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

  // the high review of #447, 1 and 2: the list and package-info keep to the
  // same scope, so neither shows what get-spec refuses
  it('/device-list lists exactly the modules each key\'s tools/list shows; package-info refuses the part', async () => {
    for (const key of [WILDCARD_KEY, SCOPED_KEY]) {
      const tools = await toolsList(key);
      const listed = (await get(key, '/device-list')).body.map((d) => d.device.friendlyName).sort();
      const shown = Object.keys(DIRS).filter((m) => toolNames(m).some((n) => tools.includes(n))).map((m) => api(m).device.friendlyName).sort();
      assert.deepStrictEqual(listed, shown, key);
    }
    const res = await get(WILDCARD_KEY, `/devices/${idOf('part')}/package-info`);
    assert.strictEqual(res.body.code, 'MODULE_NOT_LISTED', JSON.stringify(res.body));
    const echo = await get(WILDCARD_KEY, `/devices/${idOf('echo')}/package-info`);
    assert.strictEqual(echo.status, 200, JSON.stringify(echo.body));
    // a device no module serves is the same one answer on every route
    // (post-rel caller 400; byte for byte with the part's: the test below)
    const nowhere = deviceIDForName('no-such-module');
    for (const p of [`/devices/${nowhere}/package-info`, `/devices/${nowhere}/get-spec`, `/devices/${nowhere}/schema/`]) {
      const r = await get(WILDCARD_KEY, p);
      assert.deepStrictEqual([r.status, r.body.code], [404, 'MODULE_NOT_LISTED'], `${p}: ${JSON.stringify(r.body)}`);
    }
  });

  // #447's high review, 6: one predicate decides every surface that shows a
  // module, so all seven show exactly the modules expected for each key,
  // each checked against this one list (not only against each other: seven
  // wrong the same way would agree). The part is never shown; a key granted
  // some devices sees those only, its prompts and resources too. (A module
  // hidden while it goes on or off: sessions 15, in process.)
  const EXPECTED = {
    [WILDCARD_KEY]: ['echo', 'everything', 'scenario', 'transform'],
    [SCOPED_KEY]: ['echo'],
    [OTHER_KEY]: ['everything', 'transform']
  };
  // the modules each surface can show anything of: prompts and resources are
  // declared by one module here
  const HAS = {prompts: ['everything'], resources: ['everything']};
  const modules = Object.keys(DIRS);
  const ofNames = (names, nameOf) => modules.filter((m) => nameOf(m).some((n) => names.includes(n))).sort();
  const promptNames = (m) => (api(m).device.promptList || []).map((p) => promptNameFor(role(m), api(m).device.friendlyName, p.name));
  const slugOf = (m) => slugify(api(m).device.friendlyName);
  for (const key of [WILDCARD_KEY, SCOPED_KEY, OTHER_KEY]) {
    it(`${key.split('-')[0]} key: all seven surfaces show exactly the expected modules`, async () => {
      const expected = EXPECTED[key];
      const seen = {};
      seen['tools/list'] = ofNames(await toolsList(key), toolNames);
      seen['prompts/list'] = ofNames((await mcp(key, 'prompts/list')).prompts.map((p) => p.name), promptNames);
      const uris = (await mcp(key, 'resources/list')).resources.map((x) => x.uri)
        .concat((await mcp(key, 'resources/templates/list')).resourceTemplates.map((x) => x.uriTemplate));
      seen['resources/list'] = modules.filter((m) => uris.some((u) => u.startsWith(`countinghouse://m/${slugOf(m)}/`))).sort();
      for (const [label, route] of [['get-spec', 'get-spec'], ['schema', 'schema/'], ['package-info', 'package-info']]) {
        const answered = [];
        for (const m of modules) if ((await get(key, `/devices/${idOf(m)}/${route}`)).status === 200) answered.push(m);
        seen[label] = answered.sort();
      }
      const names = (await get(key, '/device-list')).body.map((d) => d.device.friendlyName);
      seen['/device-list'] = modules.filter((m) => names.includes(api(m).device.friendlyName)).sort();
      const want = {};
      for (const label of Object.keys(seen)) {
        const only = label === 'prompts/list' ? HAS.prompts : label === 'resources/list' ? HAS.resources : null;
        want[label] = only == null ? expected : expected.filter((m) => only.includes(m));
      }
      assert.deepStrictEqual(seen, want);
    });
  }

  // B-uniform (the reviewer's ruling on #457's probe): on tools/call a tool
  // the caller can't see gets one answer, a name never registered's, byte
  // for byte, plain and task-augmented: a listed module's tool outside the
  // key's grants, an unlisted part's tool outside them, and a name never
  // registered. A key granted the part still learns it is not listed.
  const callAs = (key, name, extra = {}) => new Promise((resolve, reject) => {
    const r = request(url).post('/mcp').set('Content-Type', 'application/json');
    (key != null ? r.set('X-CH-Key', key) : r)
    .send({jsonrpc: '2.0', id: 3, method: 'tools/call', params: Object.assign({name, arguments: {}}, extra)})
    .end((err, res) => (err ? reject(err) : resolve(res)));
  });
  for (const [label, extra] of [['plain', {}], ['task-augmented', {task: {ttl: 60000}}]]) {
    // no key, or a key the auth layer does not know: the auth refusal, the
    // same whatever the name (a module's tool, an unlisted part's, or one
    // never registered), so it says nothing of what exists
    it(`tools/call (${label}): no key or an unknown key is refused as such, the same for every name`, async () => {
      const names = [toolNames('echo')[0], toolNames('part')[0], 'no_such_tool_registered_anywhere'];
      for (const key of [null, `unknown-${'u'.repeat(24)}`]) {
        const seen = [];
        for (const name of names) {
          const res = await callAs(key, name, extra);
          seen.push(`${res.status} ${JSON.stringify(res.body)}`);
        }
        assert.deepStrictEqual(seen, [seen[0], seen[0], seen[0]], String(key));
        assert.ok(/"code":-32603/.test(seen[0]) && /Unknown user/.test(seen[0]), seen[0]);
      }
    });
    it(`tools/call (${label}): a tool the key can't see is answered as a name never registered, whatever the reason`, async () => {
      const shape = (res, name) => `${res.status} ${JSON.stringify(res.body).split(name).join('<name>')}`;
      const NEVER = 'no_such_tool_registered_anywhere';
      const cases = {
        'never registered': NEVER,
        'listed, outside the grants': toolNames('transform')[0],
        'an unlisted part, outside the grants': toolNames('part')[0]
      };
      const seen = {};
      for (const [why, name] of Object.entries(cases)) seen[why] = shape(await callAs(SCOPED_KEY, name, extra), name);
      const want = shape(await callAs(SCOPED_KEY, NEVER, extra), NEVER);
      assert.deepStrictEqual(seen, {'never registered': want, 'listed, outside the grants': want, 'an unlisted part, outside the grants': want});
      assert.ok(want.includes('unknown tool: <name>'), want);
      // granted the part: told it is not listed, as before
      const granted = await callAs(WILDCARD_KEY, toolNames('part')[0], extra);
      assert.ok(JSON.stringify(granted.body).includes('MODULE_NOT_LISTED'), JSON.stringify(granted.body));
    });
  }

  // post-rel caller 400: one answer, byte for byte, for a device the caller
  // can't use, whatever the reason, on every device route, end to end
  it('every device route: a device no module serves, an unlisted part and one outside the key\'s grants are one answer, byte for byte', async () => {
    const NOWHERE = 'ffffffff-0000-5000-8000-0000000000ff';
    const send = (key, method, p, body) => new Promise((resolve, reject) => {
      const r = request(url)[method](p).set('X-CH-Key', key);
      (method === 'post' ? r.send(body) : r).end((err, res) => (err ? reject(err) : resolve(JSON.stringify({status: res.status, body: res.body}))));
    });
    const body = {serviceID: 'urn:x', actionName: 'x', input: {}};
    const want = JSON.stringify({status: 404, body: {code: 'MODULE_NOT_LISTED', message: require('../../lib/error-catalogue').CODES.MODULE_NOT_LISTED.en, kind: 'caller'}});
    for (const [method, route] of [['post', 'invoke-action'], ['get', 'get-spec'], ['get', 'schema/'], ['get', 'package-info'], ['post', 'add-job']]) {
      const seen = {
        missing: await send(WILDCARD_KEY, method, `/devices/${NOWHERE}/${route}`, body),
        unlisted: await send(WILDCARD_KEY, method, `/devices/${idOf('part')}/${route}`, body),
        ungranted: await send(SCOPED_KEY, method, `/devices/${idOf('transform')}/${route}`, body)
      };
      assert.deepStrictEqual(seen, {missing: want, unlisted: want, ungranted: want}, route);
    }
  });

  // #512's high, 1: under /devices/<id>/, a path no route serves or a method
  // a route doesn't take, for a device the key is granted, answers as one it
  // isn't granted: the one JSON answer (lib/routes/device-fallback.js, mounted
  // last by lib/route-manager.js), never Express's HTML 404
  it('a sub-path no device route serves, or a wrong method, answers as a device the key isn\'t granted: one JSON answer', async () => {
    const send = (key, method, p) => new Promise((resolve, reject) => request(url)[method](p).set('X-CH-Key', key)
      .end((err, res) => (err ? reject(err) : resolve(JSON.stringify({status: res.status, type: (res.headers['content-type'] || '').split(';')[0], body: res.body})))));
    const want = JSON.stringify({status: 404, type: 'application/json', body: {code: 'MODULE_NOT_LISTED', message: require('../../lib/error-catalogue').CODES.MODULE_NOT_LISTED.en, kind: 'caller'}});
    const granted = idOf('transform');
    const seen = {
      unrouted: await send(WILDCARD_KEY, 'get', `/devices/${granted}/whatever`),
      bare: await send(WILDCARD_KEY, 'get', `/devices/${granted}`),
      wrongMethod: await send(WILDCARD_KEY, 'get', `/devices/${granted}/invoke-action`),
      ungranted: await send(SCOPED_KEY, 'get', `/devices/${granted}/whatever`)
    };
    assert.deepStrictEqual(seen, {unrouted: want, bare: want, wrongMethod: want, ungranted: want});
  });

  // post-rel caller 400, an access fix: add-job queued an unlisted part's
  // action and ran it (no listing check at all). Now it is refused, and no
  // run is ever recorded.
  it('add-job: an unlisted part\'s action is refused, and never runs', async () => {
    const name = `unlisted-probe-${Date.now()}`;
    const added = await new Promise((resolve, reject) => request(url).post(`/devices/${idOf('part')}/add-job`).set('X-CH-Key', WILDCARD_KEY)
      .send({serviceID: Object.keys(api('part').device.serviceList)[0], actionName: 'store', input: {id: 'x'}, opts: {name}})
      .end((err, res) => (err ? reject(err) : resolve(res))));
    assert.strictEqual(added.status, 404, JSON.stringify(added.body));
    assert.strictEqual(added.body.code, 'MODULE_NOT_LISTED');
    // (a run would be recorded in well under this)
    await new Promise((r) => setTimeout(r, 3000));
    const history = await new Promise((resolve, reject) => request(url).post(`/devices/${idOf('echo')}/get-job-history`).set('X-CH-Key', WILDCARD_KEY)
      .send({name}).end((err, res) => (err ? reject(err) : resolve(res))));
    assert.deepStrictEqual([history.status, history.body], [200, []], 'no run of it is recorded');
  });

  it('the unlisted part is refused MODULE_NOT_LISTED by both routes, even to a key granted every device', async () => {
    for (const p of [`/devices/${idOf('part')}/get-spec`, `/devices/${idOf('part')}/schema/`]) {
      const res = await get(WILDCARD_KEY, p);
      assert.strictEqual(res.body.code, 'MODULE_NOT_LISTED', `${p}: ${JSON.stringify(res.body)}`);
    }
  });
});
