# Shedding the IoT-era HTTP surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dead and vestigial IoT-era HTTP entry paths from countinghouse, and add a guard so the surface cannot silently grow back.

**Architecture:** Five commits, each independently green. Three deletions ordered by how visible they are (provably dead → flag-gated but reachable → inert parameter), then a route-inventory guard, then documentation. Nothing here touches the MCP surface, so the pre-commit golden `tools/list` check must stay byte-identical throughout.

**Tech Stack:** Node 20, express 4.22.2, mocha + supertest, ajv 8.

**Spec:** `docs/superpowers/specs/2026-09-04-shed-iot-era-surface-design.md`

## Global Constraints

- **Node 20.20.2 lives at `~/.local/node-v20/bin` — put it on `PATH` first.** System `node` is v16 and will fail. No sudo. `mocha` is at `./node_modules/.bin`.
- **Redis must be reachable at `redis://127.0.0.1:6379`** for most of the suite. Check with `redis-cli ping`.
- **Test loop:** test1–test6 plus the globbed suites. **Skip `test7.js`** — it is a benchmark. `npm test` runs everything including test7.
- **Baseline before this plan starts:** 433 passing, 3 pending, 0 failing, at master `fa888b2`.
- **One task per commit. Run the suite before each commit.**
- **A pre-commit hook runs `eslint` and asserts `tools/list` is byte-identical to the golden sample.** It will block a commit that moves the MCP surface. None of this work should move it.
- **All new docs and code comments in English** (per `CLAUDE.md`).
- **Never delete `adaptive-test/`, `perf/`, `spec/`** — benchmarks are assets.
- **Do not touch** `/devices/:deviceID/package-info`, `/download-package`, `/verify-module`, `/get-module-device-list`. They look dead but are item #2/B1's to decide. See the spec's Scope section.

**Note on commit count:** the spec describes four code commits. Documentation lands as a fifth, following this repo's convention of a separate `docs(7.0.0):` commit after the change it describes (`5756eb0`→`0b63f0c`, `5a85d0e`→`7c11d2d`).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/route-manager.js` | The single mount point for every HTTP entry path | 1, 2 |
| `lib/cli-options.js` | Flag parsing and the options dump | 1, 2 |
| `lib/countinghouse-interface.js` | Presentation event wiring; `loadLevel` accounting; `token` params | 1, 2, 3 |
| `lib/module-manager.js` | `allowDiscover` branches | 1 |
| `lib/countinghouse-device.js` | `CHDevice.getDeviceRootUrl` | 1 |
| `lib/device-manager.js` | `ensureDeviceState` and its `token` param | 3 |
| `lib/routes/{invoke-action,get-spec,schema}.js` | `device_access_token` reads | 3 |
| `lib/error-info.{en-US,zh-CN}.json` | Error catalogue, both locales | 1 |
| `test/auth/16-removed-iot-routes.js` | 404 regression for every removed path | 1, 2 |
| `test/fixtures/route-inventory.js` | Child-process introspection helper | 4 |
| `test/fixtures/route-inventory.json` | The golden inventory | 4 |
| `test/module-loading/11-route-inventory.js` | The guard | 4 |
| `docs/cross-cutting-matrix.md`, `CHANGELOG.md` | The record | 5 |

Deleted: `lib/routes/{connect,disconnect,discover,stop-discover,load-profile}.js`, `lib/routes/openstack/`, `lib/device-auth.js`.

---

### Task 1: Remove the dead entry paths

Everything here throws or never mounts today, so **no client-visible behavior changes**. See the spec's Group 1 table for the evidence per path.

**Files:**
- Create: `test/auth/16-removed-iot-routes.js`
- Modify: `lib/route-manager.js`, `lib/cli-options.js`, `lib/countinghouse-interface.js`, `lib/module-manager.js`, `lib/countinghouse-device.js`, `lib/error-info.en-US.json`, `lib/error-info.zh-CN.json`
- Delete: `lib/routes/connect.js`, `lib/routes/disconnect.js`, `lib/routes/discover.js`, `lib/routes/stop-discover.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `test/auth/16-removed-iot-routes.js` with a `describe` block that Task 2 extends. Port `9547` is claimed by this file.

- [ ] **Step 1: Write the failing test**

Create `test/auth/16-removed-iot-routes.js`. Port 9547 is unused across `test/` and `examples/` (verified 2026-09-04; used ports are 9530–9531, 9541–9546, 9550–9564, 9574–9575, 9584–9595).

```js
const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

// Covers the 7.0.0 removal of the IoT-era entry paths. None was a working
// feature when it was removed; this file exists so that reinstating any of
// them is a deliberate act rather than an accident. Same role as
// test/auth/14-removed-callback-routes.js, which covers the earlier pair.
//
//   /devices/:deviceID/connect     -- routes/connect.js called
//     cdifInterface.connectDevice, a method defined nowhere in the repo, so
//     every POST threw TypeError. The file also referenced CHError without
//     importing it, so its own validation branches threw ReferenceError.
//   /devices/:deviceID/disconnect  -- same shape, cdifInterface.disconnectDevice.
//   /discover, /stop-discover      -- mounted only under options.allowDiscover,
//     which cli-options.js hardcoded to false ("broken under worker thread
//     mode"). Never mounted at all.
//   /devices/:deviceID/presentation -- dead twice: deviceManager never emitted
//     the 'presentation' event that mounts it, and the mount handler called
//     cdifInterface.getDeviceRootUrl, never defined on CdifInterface.
const PORT             = 9547;
const url              = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-auth-16-${process.pid}.json`;

const ALICE = `alice-key-16-${process.pid}`;

describe('auth 16: the dead IoT-era entry paths are gone', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    const config = {};
    config[ALICE] = {userName: 'alice', devices: ['*']};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse WITHOUT --debug, for removed IoT-route test...');
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT
         } --authProvider file --authConfigPath ${AUTH_CONFIG_PATH
         } --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => { done(); });
  });

  // Without this, every 404 below could pass because the server never booted.
  it('the server is up (guard: proves the 404s below mean "no such route")', (done) => {
    request(url).get('/balance').set('X-CH-Key', ALICE).expect(200, done);
  });

  it('POST /devices/:deviceID/connect is 404 (was: TypeError)', (done) => {
    request(url).post('/devices/some-device-id/connect')
                .set('X-CH-Key', ALICE)
                .set('Content-Type', 'application/json')
                .send({username: 'u', password: 'p'})
                .expect(404, done);
  });

  it('POST /devices/:deviceID/disconnect is 404 (was: TypeError)', (done) => {
    request(url).post('/devices/some-device-id/disconnect')
                .set('X-CH-Key', ALICE)
                .set('Content-Type', 'application/json')
                .send({device_access_token: 'x'})
                .expect(404, done);
  });

  it('POST /discover is 404', (done) => {
    request(url).post('/discover').set('X-CH-Key', ALICE).expect(404, done);
  });

  it('POST /stop-discover is 404', (done) => {
    request(url).post('/stop-discover').set('X-CH-Key', ALICE).expect(404, done);
  });

  it('GET /devices/:deviceID/presentation is 404', (done) => {
    request(url).get('/devices/some-device-id/presentation')
                .set('X-CH-Key', ALICE).expect(404, done);
  });

  // The live neighbours must be unaffected -- this is a removal, not a
  // regression in the device-scoped router that hosted two of them.
  it('the surviving device-scoped routes still respond (not 404)', (done) => {
    request(url).get('/device-list').set('X-CH-Key', ALICE).expect(200, done);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH=$HOME/.local/node-v20/bin:$PWD/node_modules/.bin:$PATH
mocha ./test/auth/16-removed-iot-routes.js
```

Expected: the `connect` and `disconnect` cases FAIL (they return 500, not 404, because the route is mounted and throws). The `/discover`, `/stop-discover` and `presentation` cases already pass — those paths are unmounted today, and that is exactly what the spec claims. Do not treat their passing as the test being broken.

- [ ] **Step 3: Delete the four dead route files**

```bash
git rm lib/routes/connect.js lib/routes/disconnect.js lib/routes/discover.js lib/routes/stop-discover.js
```

- [ ] **Step 4: Remove the mounts and the presentation machinery from `lib/route-manager.js`**

Delete these two lines from `installNormalRoutes` (currently lines 100–101):

```js
  this.deviceControlRouter.use('/:deviceID/connect',          require('./routes/connect')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/disconnect',       require('./routes/disconnect')(this.moduleManager, this.cdifInterface));
```

Delete the whole `allowDiscover` block (currently lines 113–117):

```js
  if (options.allowDiscover) {
    this.app.use('/',              require('./routes/user'));
    this.app.use('/discover',      require('./routes/discover')(this.moduleManager, this.cdifInterface));
    this.app.use('/stop-discover', require('./routes/stop-discover')(this.moduleManager, this.cdifInterface));
  }
```

Delete the presentation subscription (currently line 119):

```js
  this.cdifInterface.on('presentation', this.mountDevicePresentationPage.bind(this));
```

Delete the entire `RouteManager.prototype.mountDevicePresentationPage` method (currently lines 122–138), and the `presentationRouter` field in the constructor (currently line 28):

```js
  this.presentationRouter  = express.Router({mergeParams: true});
```

`Session` and `CHError` are required at the top of the file only for `mountDevicePresentationPage`. After removing it, check whether either is still referenced; if not, remove those requires too. `eslint` in the pre-commit hook will flag unused vars.

- [ ] **Step 5: Remove `allowDiscover` from `lib/cli-options.js`**

Delete line 7:

```js
    this.allowDiscover           = false; //disable allowDiscover flag because it is broken under worker thread mode
```

and its entry in `getOptions()` (line 118):

```js
      allowDiscover:            this.allowDiscover,
```

- [ ] **Step 6: Unwrap the `allowDiscover` branches in `lib/module-manager.js`**

Two branches reference it. The first (lines 71–75) is unreachable — `allowDiscover` was always `false`, so this early-return never fired:

```js
  if (options.allowDiscover === true && options.workerThread === true) {
    //TODO: manually send discover event to worker start from main thread
    LOG.E('we do not support emit discover events in main thread yet');
    return;
  }
```

Delete it entirely.

The second (line 77) wraps the **live** discovery branches:

```js
  if (options.allowDiscover === false) {
    if (options.workerThread === true && isMainThread === true) {
      ... // KEEP
    } else if (options.workerThread === false && isMainThread === true) {
      ... // KEEP
    } else {
      ... // KEEP
    }
  }
```

Remove only the `if (options.allowDiscover === false) {` line and its matching closing brace, then re-indent the body one level. **Do not delete the body** — it is the normal module-load path.

- [ ] **Step 7: Remove the presentation wiring from `lib/countinghouse-interface.js`**

Delete line 88 in the constructor:

```js
  this.deviceManager.on('presentation', this.onDevicePresentation.bind(this));
```

and the method (lines 202–204):

```js
CdifInterface.prototype.onDevicePresentation = function(deviceID) {
  this.emit('presentation', deviceID);
};
```

Nothing emits `presentation` on `deviceManager` — verified by grep across `lib/`. This subscription listened for an event that was never raised.

- [ ] **Step 8: Remove `CHDevice.getDeviceRootUrl` from `lib/countinghouse-device.js`**

Delete the whole method (lines 153–169, including the `// get device root url string` comment above it). Its only caller was `RouteManager.mountDevicePresentationPage`, removed in Step 4.

Then check whether `url` (required at the top for `url.parse` inside this method) is still used elsewhere in the file; remove the require if not.

- [ ] **Step 9: Remove the three now-unreachable error codes from both locales**

From `lib/error-info.en-US.json` (lines 15–17):

```json
  "PRESENTATION_NOT_SUPPORTED": "Device does not support a presentation URL",
  "GET_DEVICE_ROOTURL_FAIL": "Failed to get device root URL",
  "PARSE_DEVICE_ROOTURL_FAIL": "Failed to parse device root URL",
```

and the matching three from `lib/error-info.zh-CN.json` (lines 15–17). Both locales must stay in sync — the catalogue is asserted key-for-key elsewhere in the suite.

- [ ] **Step 10: Run the new test to verify it passes**

```bash
mocha ./test/auth/16-removed-iot-routes.js
```

Expected: 7 passing, 0 failing.

- [ ] **Step 11: Run the full suite**

```bash
mocha ./test/test1.js && mocha ./test/test2.js && mocha ./test/test3.js && \
mocha ./test/test4.js && mocha --exit ./test/test5.js && \
mocha ./test/auth/*.js ./test/device-config/*.js ./test/module-loading/*.js \
      ./test/spec-format/*.js ./test/mcp-contract/*.js ./test/validation/*.js \
      ./test/module-authoring/*.js && \
mocha --exit ./test/composition/*.js && mocha ./test/test8.js && \
npm run test:peer-standalone && mocha ./test/test6.js
```

Expected: 0 failing. Total rises from 433 by the 7 new cases.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "remove(7.0.0): the dead IoT-era entry paths

connect and disconnect called cdifInterface.connectDevice /
disconnectDevice, neither defined anywhere in the repo, so every POST
threw TypeError; connect.js also used CHError without importing it.
/discover and /stop-discover sat behind options.allowDiscover, which
cli-options.js hardcoded to false, so they were never mounted.
/devices/:deviceID/presentation was dead twice over -- deviceManager
never emitted the 'presentation' event that mounts it, and the mount
handler called cdifInterface.getDeviceRootUrl, never defined.

Breaking on paper, no behavior change in fact: every one of these
threw or never mounted. Same class as the /callbacks and /callback_url
removals earlier in 7.0.0.

Keeps CdifInterface.discoverAll/stopDiscoverAll and
DeviceManager.onDiscoverAll/onStopDiscoverAll -- lib/sandbox.js calls
both on the normal worker-mode module-load path, so they are not
reachable only from the removed routes.

Test: test/auth/16-removed-iot-routes.js

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Remove the vestigial flag-gated surface

Unlike Task 1, **this one does change behavior** for anyone who set `--simOpenStackAPI` or `--loadProfile`. That is what makes it major-version work.

**Files:**
- Modify: `test/auth/16-removed-iot-routes.js`, `lib/route-manager.js`, `lib/cli-options.js`, `lib/countinghouse-interface.js`
- Delete: `lib/routes/openstack/createServer.js`, `lib/routes/openstack/deleteServer.js`, `lib/routes/load-profile.js`

**Interfaces:**
- Consumes: `test/auth/16-removed-iot-routes.js` from Task 1.
- Produces: nothing later tasks depend on. Port `9548` is claimed by this file.

- [ ] **Step 1: Write the failing test**

Append a second `describe` to `test/auth/16-removed-iot-routes.js`. It starts the server **with both flags set**, which is the case that would otherwise regress silently — a flag-gated route removed from the default surface but still mounted when its flag is on.

```js
// Started WITH the flags that used to mount these, because that is the case
// that could regress silently. --simOpenStackAPI mounted the OpenStack
// simulation with no userAuth at all ("openstack api simulation don't do
// user auth"), one flag away from live; --loadProfile mounted /load-profile.
// Both flags are gone in 7.0.0, so a server given them must still boot and
// must not mount anything.
const PORT_FLAGS  = 9548;
const urlFlags    = `http://127.0.0.1:${PORT_FLAGS}`;
const FLAGS_AUTH  = `/tmp/countinghouse-test-auth-16b-${process.pid}.json`;
const BOB         = `bob-key-16b-${process.pid}`;

describe('auth 16b: the vestigial flag-gated surface is gone', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    const config = {};
    config[BOB] = {userName: 'bob', devices: ['*']};
    fs.writeFileSync(FLAGS_AUTH, JSON.stringify(config));

    console.log('starting countinghouse WITH --simOpenStackAPI --loadProfile (both now no-ops)...');
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT_FLAGS
         } --authProvider file --authConfigPath ${FLAGS_AUTH
         } --simOpenStackAPI --loadProfile` +
         ` --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    try { fs.unlinkSync(FLAGS_AUTH); } catch (e) {}
    exec(`pkill -f "framework.js.*${FLAGS_AUTH}"`, () => { done(); });
  });

  // An unknown flag must not stop the server booting -- otherwise the 404s
  // below would pass for the wrong reason, and an operator upgrading with the
  // old flag in their startup script would get a dead server instead of a
  // route that quietly no longer exists.
  it('the server still boots when given the removed flags', (done) => {
    request(urlFlags).get('/balance').set('X-CH-Key', BOB).expect(200, done);
  });

  it('POST /v2/:tenantID/servers is 404', (done) => {
    request(urlFlags).post('/v2/tenant-1/servers')
                     .set('Content-Type', 'application/json')
                     .send({name: 'x'}).expect(404, done);
  });

  it('DELETE /v2/:tenantID/servers/:serverID is 404', (done) => {
    request(urlFlags).delete('/v2/tenant-1/servers/server-1').expect(404, done);
  });

  it('GET /load-profile is 404', (done) => {
    request(urlFlags).get('/load-profile').set('X-CH-Key', BOB).expect(404, done);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
mocha ./test/auth/16-removed-iot-routes.js
```

Expected: the three 404 cases in `auth 16b` FAIL — the routes are still mounted when the flags are set. Task 1's cases must all still pass.

- [ ] **Step 3: Delete the route files**

```bash
git rm -r lib/routes/openstack
git rm lib/routes/load-profile.js
```

- [ ] **Step 4: Remove the mounts from `lib/route-manager.js`**

Delete the `loadProfile` block (currently lines 82–84):

```js
  if (options.loadProfile === true) {
    this.app.use('/load-profile',  require('./routes/load-profile')(this.moduleManager, this.cdifInterface));
  }
```

Delete the OpenStack block (currently lines 92–95):

```js
  if (options.simOpenStackAPI === true) {
    // openstack api simulation don't do user auth
    this.installOpenStackRoutes(this.app, this.moduleManager, this.cdifInterface);
  }
```

Delete the whole `RouteManager.prototype.installOpenStackRoutes` method (currently lines 151–154):

```js
RouteManager.prototype.installOpenStackRoutes = function(app, mm, ci) {
  app.use('/v2/:tenantID/servers', require('./routes/openstack/createServer')(mm, ci));
  app.use('/v2/:tenantID/servers/:serverID', require('./routes/openstack/deleteServer')(mm, ci));
};
```

- [ ] **Step 5: Remove both flags from `lib/cli-options.js`**

Delete line 11 and line 100:

```js
    this.loadProfile             = (argv.loadProfile     === true) ? true : false;
    this.simOpenStackAPI = (argv.simOpenStackAPI === true) ? true : false;
```

and their entries in `getOptions()` (lines 122 and 141):

```js
      loadProfile:              this.loadProfile,
      simOpenStackAPI:          this.simOpenStackAPI,
```

Unknown CLI flags are ignored by the argv parser, so a startup script still passing `--loadProfile` keeps working — the flag simply does nothing. That is what `auth 16b`'s first case asserts.

- [ ] **Step 6: Remove the `loadLevel` accounting from `lib/countinghouse-interface.js`**

`/load-profile` was the only reader, so the counter is dead once it is gone. Delete the initializer (lines 37–44):

```js
  if (options.loadProfile === true && isMainThread === true) {
    this.lastMinuteLoadLevel = 0;
    this.loadLevel = 0;
    setInterval(() => {
      this.lastMinuteLoadLevel = this.loadLevel;
      LOG.I(`requests in last 10 minutes: ${this.loadLevel}`);
      this.loadLevel = 0;
    }, 10 * 60 * 1000);
  }
```

Delete the four increment lines — in `getDiscoveredDeviceList` (102), `invokeDeviceAction` (108), `getDeviceSpec` (163) and `getDeviceSchema` (177). Each is the same single line plus its following blank line:

```js
  if (options.loadProfile === true) this.loadLevel ++;
```

Delete `CdifInterface.prototype.getServerLoadLevel` (lines 206–209) and the `//For now we ignore interval argument` comment above it:

```js
CdifInterface.prototype.getServerLoadLevel = function(interval, callback) {
  callback(null, this.lastMinuteLoadLevel);
};
```

- [ ] **Step 7: Run the new test to verify it passes**

```bash
mocha ./test/auth/16-removed-iot-routes.js
```

Expected: 11 passing (7 from Task 1 + 4 new), 0 failing.

- [ ] **Step 8: Run the full suite**

Same command as Task 1 Step 11. Expected: 0 failing.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "remove(7.0.0): the vestigial flag-gated IoT surface

The OpenStack simulation (--simOpenStackAPI) hardcoded a single 2015
China Mobile target -- one deviceID UUID, a Chinese serviceID and
actionName -- and was mounted ahead of routes/user.js with no
authentication at all, the code saying so at the mount point. It was
one CLI flag away from being a live unauthenticated entry path, the
same shape that put /callbacks on the pre-release audit's list.

/load-profile (--loadProfile) returned lastMinuteLoadLevel and ignored
its interval argument. It was the only reader of the loadLevel counter,
so the counter, its 10-minute interval timer and its four increment
sites go with it rather than being left dead.

Both flags are removed. Unknown flags are ignored by the argv parser,
so a startup script still passing either one boots normally and simply
gets no route -- asserted by the new test rather than assumed.

Unlike the previous commit this is a real behavior change for anyone
who set either flag, which is why it wants the major.

Test: test/auth/16-removed-iot-routes.js (auth 16b)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Remove the inert `device_access_token` plumbing

`ensureDeviceState(deviceID, token, callback)` never reads `token`. `lib/device-auth.js`, which would have issued one, is required by nothing. `connect`, the route that would have issued it, went in Task 1. Invisible to clients: a token sent today is already ignored.

**Files:**
- Modify: `lib/device-manager.js`, `lib/countinghouse-interface.js`, `lib/routes/invoke-action.js`, `lib/routes/get-spec.js`, `lib/routes/schema.js`
- Delete: `lib/device-auth.js`

**Interfaces:**
- Consumes: Task 2's tree (the OpenStack routes are gone; they were two of the token-passing call sites).
- Produces: `ensureDeviceState(deviceID, callback)`, `CdifInterface.invokeDeviceAction(deviceID, serviceID, actionName, args, session)`, `CdifInterface.getDeviceSpec(deviceID, session)`, `CdifInterface.getDeviceSchema(deviceID, path, session)`, `DeviceManager.onInvokeDeviceAction(deviceID, serviceID, actionName, args, session)`, `DeviceManager.onGetDeviceSpec(deviceID, session)`, `DeviceManager.onGetDeviceSchema(deviceID, path, session)`.

- [ ] **Step 1: Confirm `lib/device-auth.js` is genuinely unreferenced**

```bash
grep -rn "device-auth\|DeviceAuth" lib/ test/ examples/ bin/ framework.js 2>/dev/null | grep -v node_modules
```

Expected: matches only inside `lib/device-auth.js` itself. If anything else matches, **stop** — the spec's claim is wrong and this task needs rethinking.

- [ ] **Step 2: Write the failing test**

There is no behavior to assert — the parameter is already ignored, so no black-box test can distinguish before from after. The guard is therefore a static one: assert the plumbing is gone and cannot creep back. Add to `test/auth/16-removed-iot-routes.js`:

```js
// device_access_token was CDIF-era device-connect state. ensureDeviceState
// took it and never read it, lib/device-auth.js (which would have issued one)
// was imported by nothing, and /connect (which would have handed one out) is
// removed above. Nothing observable changes when it goes -- so this asserts
// the plumbing itself is gone, which is the only thing that can regress.
describe('auth 16c: the inert device_access_token plumbing is gone', function() {
  const fsSync = require('fs');
  const pathMod = require('path');
  const ROOT_DIR = pathMod.join(__dirname, '..', '..');

  it('lib/device-auth.js no longer exists', () => {
    assert.strictEqual(fsSync.existsSync(pathMod.join(ROOT_DIR, 'lib', 'device-auth.js')), false);
  });

  it('no route reads device_access_token', () => {
    const files = ['invoke-action.js', 'get-spec.js', 'schema.js'];
    for (const f of files) {
      const src = fsSync.readFileSync(pathMod.join(ROOT_DIR, 'lib', 'routes', f), 'utf8');
      assert.ok(src.indexOf('device_access_token') === -1,
        `lib/routes/${f} still reads device_access_token`);
    }
  });

  it('ensureDeviceState takes no token parameter', () => {
    const src = fsSync.readFileSync(pathMod.join(ROOT_DIR, 'lib', 'device-manager.js'), 'utf8');
    assert.ok(/ensureDeviceState = function\(deviceID, callback\)/.test(src),
      'ensureDeviceState should now be (deviceID, callback)');
  });
});
```

Add `const assert = require('assert');` to the top of the file if Task 1 did not already.

- [ ] **Step 3: Run the test to verify it fails**

```bash
mocha ./test/auth/16-removed-iot-routes.js
```

Expected: all three `auth 16c` cases FAIL.

- [ ] **Step 4: Delete `lib/device-auth.js`**

```bash
git rm lib/device-auth.js
```

- [ ] **Step 5: Drop the parameter from `ensureDeviceState` in `lib/device-manager.js`**

Change the signature (line 1209) from:

```js
DeviceManager.prototype.ensureDeviceState = function(deviceID, token, callback) {
```

to:

```js
DeviceManager.prototype.ensureDeviceState = function(deviceID, callback) {
```

The body is unchanged — it never referenced `token`.

Update all six call sites (lines 1284, 1293, 1342, 1369, 1450, 1463). Three already pass `null`; three pass `token`. All become:

```js
  this.ensureDeviceState(deviceID, (err, cdifDevice) => {
```

- [ ] **Step 6: Drop `token` from the three `DeviceManager` methods that only forwarded it**

```js
DeviceManager.prototype.onInvokeDeviceAction = function(deviceID, serviceID, actionName, args, session) {
DeviceManager.prototype.onGetDeviceSpec = function(deviceID, session) {
DeviceManager.prototype.onGetDeviceSchema = function(deviceID, path, session) {
```

- [ ] **Step 7: Drop `token` from the matching `CdifInterface` methods**

In `lib/countinghouse-interface.js`:

```js
CdifInterface.prototype.invokeDeviceAction = function(deviceID, serviceID, actionName, args, session) {
  ...
  this.deviceManager.emit('invokeaction', deviceID, serviceID, actionName, args, session);
};

CdifInterface.prototype.getDeviceSpec = function(deviceID, session) {
  this.deviceManager.emit('getspec', deviceID, session);
};

CdifInterface.prototype.getDeviceSchema = function(deviceID, path, session) {
  this.deviceManager.emit('getschema', deviceID, path, session);
};
```

Keep the body of `invokeDeviceAction` otherwise intact — it carries the `args.ctx` caller-identity logic, which is unrelated and load-bearing.

- [ ] **Step 8: Update every caller**

After Task 2 there are exactly five `invokeDeviceAction` call sites and five spec/schema ones. Drop the `null`/`token` argument from each:

- `lib/service-client.js:95` — `this.cdifInterface.invokeDeviceAction(this.deviceID, this.serviceID, opts.actionName, args, session);`
- `lib/sandbox.js:93` — `ci.invokeDeviceAction(msg.deviceID, msg.serviceID, msg.actionName, msg.args, (err, data) => {`
- `lib/mcp/gateway.js:680` — `cdifInterface.invokeDeviceAction(target.deviceID, target.serviceID, target.actionName, args, session);`
- `lib/device-manager.js:405` — `CHUtil.ci.invokeDeviceAction(request.deviceID, request.serviceID, request.actionName, {input: request.input}, (err, data) => {`
- `lib/routes/invoke-action.js:68` — `cdifInterface.invokeDeviceAction(deviceID, serviceID, actionName, argumentList, session);`
- `lib/sandbox.js:105` — `ci.getDeviceSpec(msg.deviceID, (err, data) => {`
- `lib/sandbox.js:111` — `ci.getDeviceSchema(msg.deviceID, msg.path, (err, data) => {`
- `lib/routes/get-spec.js:11` — `cdifInterface.getDeviceSpec(deviceID, session);`
- `lib/routes/schema.js:13` — `cdifInterface.getDeviceSchema(deviceID, path, session);`
- `lib/mcp/tool-registry.js:284` — `cdifInterface.getDeviceSchema(deviceID, path, session);`

`lib/device-manager.js:1352` and `:1362` call `cdifDevice.getDeviceSpec(session)` — that is `CHDevice.getDeviceSpec`, a **different method** that never took a token. Leave both alone.

- [ ] **Step 9: Remove the three `device_access_token` reads**

Delete these lines and drop the now-unused `token` local in each file:

- `lib/routes/invoke-action.js:42` — `const token      = data.device_access_token;`
- `lib/routes/get-spec.js:9` — `const token    = req.body.device_access_token;`
- `lib/routes/schema.js:10` — `const token    = req.body.device_access_token;`

- [ ] **Step 10: Run the new test to verify it passes**

```bash
mocha ./test/auth/16-removed-iot-routes.js
```

Expected: 14 passing, 0 failing.

- [ ] **Step 11: Run the full suite**

Same command as Task 1 Step 11. This task changes shared signatures, so a failure here is most likely a missed call site. Expected: 0 failing.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "remove(7.0.0): the inert device_access_token plumbing

ensureDeviceState took a token parameter and never read it -- it checks
that the device exists and is online, nothing else. lib/device-auth.js,
the jwt implementation that would have issued such a token, was imported
by no file in the repo, and /connect, the route that would have handed
one out, was removed earlier in 7.0.0.

So the token was threaded from three routes through CdifInterface and
DeviceManager to be discarded. Dropped from the whole chain. A client
still sending device_access_token is unaffected: it was already ignored.

CHDevice.getDeviceSpec is a different method that never took a token and
is untouched.

Test: test/auth/16-removed-iot-routes.js (auth 16c), which asserts the
plumbing is gone -- no black-box test can distinguish before from after,
because nothing observable changes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The route-inventory guard

Adding an entry path now fails a test until the author records it. This is the preventive half of the item — the matrix documents the same unenumerated-route bug shape recurring four times, and deletion alone does not change those odds.

**Files:**
- Create: `test/fixtures/route-inventory.js`, `test/fixtures/route-inventory.json`, `test/module-loading/11-route-inventory.js`

**Interfaces:**
- Consumes: the post-Task-3 route surface.
- Produces: `test/fixtures/route-inventory.js`, a standalone script printing the sorted JSON inventory to stdout and exiting 0.

**Design note — why a child process.** Requiring `lib/route-manager.js` in-process leaves open handles: a prototype run printed its result and then hung until killed. The `module-loading` glob runs **without** `--exit`, so an open handle there would stall the whole suite. The helper therefore runs as its own process, ends with `process.exit(0)`, and the test compares its stdout. Verified working against express 4.22.2 on 2026-09-04.

- [ ] **Step 1: Create the introspection helper**

Create `test/fixtures/route-inventory.js`:

```js
// Prints the sorted list of every HTTP path lib/route-manager.js mounts, one
// JSON array on stdout. Run as its own process by
// test/module-loading/11-route-inventory.js -- requiring route-manager in the
// mocha process leaves open handles, and the module-loading glob runs without
// --exit, so an in-process version would stall the suite.
//
// installNormalRoutes is called against a stub rather than a real
// RouteManager: the route modules only build routers at mount time and do not
// touch mm/cdifInterface until a request arrives, so stubs are enough to get a
// faithful mount table without booting a server or binding a port.
const events  = require('events');
const express = require('express');
const path    = require('path');

const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'lib', 'cli-options')).setOptions({});
const RouteManager = require(path.join(ROOT, 'lib', 'route-manager'));

const fake = Object.create(RouteManager.prototype);
fake.app                 = express();
fake.deviceControlRouter = express.Router();
fake.moduleManager       = new events.EventEmitter();
fake.cdifInterface       = new events.EventEmitter();
fake.cdifInterface.deviceManager = new events.EventEmitter();

RouteManager.prototype.installNormalRoutes.call(fake);

// express 4 stores each mount as a regexp; decode it back to a readable path.
// layer.keys carries the :param names in order, so the capture groups can be
// put back as :deviceID rather than left as (?:/([^/]+?)).
function seg(layer) {
  if (layer.regexp == null || layer.regexp.fast_slash) return '';
  let s = layer.regexp.source;
  s = s.replace(/^\^/, '');
  s = s.replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');   // use()-style tail
  s = s.replace(/\\\/\?\$$/, '');                 // route()-style tail
  s = s.replace(/\\\//g, '/');
  let i = 0;
  return s.replace(/\(\?:\/\(\[\^\/\]\+\?\)\)/g,
                   () => '/:' + ((layer.keys && layer.keys[i++]) || {name: 'param'}).name);
}

function walk(stack, prefix) {
  const out = [];
  for (const layer of stack) {
    const here = prefix + seg(layer);
    if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      out.push(...walk(layer.handle.stack, here));
    } else if (here !== '') {
      out.push(here);
    }
  }
  return out;
}

// app.router (no underscore) is a throwing deprecation getter in express 4, so
// this must use _router -- and must fail loudly if a future express drops it,
// rather than reporting an empty inventory that would pass forever.
if (fake.app._router == null || !Array.isArray(fake.app._router.stack)) {
  process.stderr.write('cannot read app._router.stack -- express internals moved; ' +
                       'update test/fixtures/route-inventory.js\n');
  process.exit(2);
}

const inventory = [...new Set(walk(fake.app._router.stack, ''))].sort();
process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
process.exit(0);
```

- [ ] **Step 2: Generate the golden file and eyeball it**

```bash
export PATH=$HOME/.local/node-v20/bin:$PATH
node ./test/fixtures/route-inventory.js > ./test/fixtures/route-inventory.json
cat ./test/fixtures/route-inventory.json
```

Expected — exactly 20 entries after Tasks 1–3. If `connect`, `disconnect`, `load-profile` or `/v2/...` appear, an earlier task is incomplete; go back rather than accepting the golden file.

```json
[
  "/balance",
  "/device-list",
  "/devices/:deviceID",
  "/devices/:deviceID/add-job",
  "/devices/:deviceID/download-package",
  "/devices/:deviceID/get-job",
  "/devices/:deviceID/get-job-history",
  "/devices/:deviceID/get-spec",
  "/devices/:deviceID/invoke-action",
  "/devices/:deviceID/package-info",
  "/devices/:deviceID/remove-job",
  "/devices/:deviceID/schema/(.*)",
  "/get-module-device-list",
  "/load-module",
  "/mcp",
  "/reload-module",
  "/restart-module",
  "/shutdown",
  "/unload-module",
  "/verify-module"
]
```

- [ ] **Step 3: Write the guard test**

Create `test/module-loading/11-route-inventory.js`:

```js
const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const spawn   = require('child_process').spawnSync;

// Every HTTP entry path owes a docs/cross-cutting-matrix.md row, an auth story
// and a metering story, forever. /callbacks stayed unauthenticated for years
// because nobody had enumerated the routes, and the matrix records that same
// shape recurring four times. This makes the enumeration mechanical: a new
// mount fails here until it is written down.
//
// Mirrors the golden tools/list contract the pre-commit hook already enforces
// for the MCP surface.
const ROOT    = path.join(__dirname, '..', '..');
const HELPER  = path.join(ROOT, 'test', 'fixtures', 'route-inventory.js');
const GOLDEN  = path.join(ROOT, 'test', 'fixtures', 'route-inventory.json');

function readInventory(extraEnv) {
  const res = spawn(process.execPath, [HELPER], {
    cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, extraEnv || {})
  });
  assert.strictEqual(res.status, 0,
    `route-inventory helper exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

describe('module-loading 11: the HTTP route inventory is declared', function() {
  this.timeout(30000);

  it('every mounted path is in the golden inventory, and vice versa', () => {
    const actual = readInventory();
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));

    const added   = actual.filter((p) => golden.indexOf(p) === -1);
    const removed = golden.filter((p) => actual.indexOf(p) === -1);

    assert.deepStrictEqual({added: added, removed: removed}, {added: [], removed: []},
      'The mounted HTTP routes no longer match test/fixtures/route-inventory.json.\n' +
      `  added (mounted but not declared): ${JSON.stringify(added)}\n` +
      `  removed (declared but not mounted): ${JSON.stringify(removed)}\n` +
      'If you added a route: add its row to docs/cross-cutting-matrix.md -- auth, ' +
      'metering, rate limit, timeout, error shape -- then regenerate the golden file ' +
      'with:\n  node ./test/fixtures/route-inventory.js > ./test/fixtures/route-inventory.json\n' +
      'A missing matrix row is worse than a blank cell.');
  });

  // Without this the test above could pass by comparing two empty lists, or by
  // silently reporting nothing when express internals move.
  it('the inventory is non-empty and contains the known-live routes', () => {
    const actual = readInventory();
    assert.ok(actual.length >= 15, `implausibly small inventory: ${JSON.stringify(actual)}`);
    for (const known of ['/mcp', '/balance', '/devices/:deviceID/invoke-action']) {
      assert.ok(actual.indexOf(known) !== -1, `expected ${known} in the inventory`);
    }
  });

  it('the removed IoT-era paths are absent', () => {
    const actual = readInventory();
    for (const gone of ['/devices/:deviceID/connect', '/devices/:deviceID/disconnect',
                        '/load-profile', '/v2/:tenantID/servers']) {
      assert.strictEqual(actual.indexOf(gone), -1, `${gone} is mounted again`);
    }
  });
});
```

- [ ] **Step 4: Run the guard to verify it passes**

```bash
mocha ./test/module-loading/11-route-inventory.js
```

Expected: 3 passing, 0 failing.

- [ ] **Step 5: Prove the guard is not vacuous**

A guard that cannot fail is worse than none. Temporarily add a route to `lib/route-manager.js`'s `installNormalRoutes`:

```js
  this.app.use('/temporary-canary', (req, res) => res.status(200).end());
```

Run:

```bash
mocha ./test/module-loading/11-route-inventory.js
```

Expected: the first case FAILS, naming `/temporary-canary` under `added`. **Then revert the line** and re-run to confirm 3 passing again. Do not commit the canary.

- [ ] **Step 6: Run the full suite**

Same command as Task 1 Step 11. Pay attention to whether the `module-loading` glob still terminates — that is the risk this task's child-process design exists to avoid. Expected: 0 failing.

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/route-inventory.js test/fixtures/route-inventory.json \
        test/module-loading/11-route-inventory.js
git commit -m "test(7.0.0): declare the HTTP route inventory, and guard it

Every HTTP entry path owes a cross-cutting-matrix row, an auth story and
a metering story, forever. /callbacks stayed unauthenticated for years
precisely because nobody had enumerated the routes, and the matrix
records the same shape recurring four times. Removing routes does not
change those odds; enumerating them does.

Adding a mount now fails module-loading 11 until it is declared, and the
failure message asks for the matrix row rather than just the golden file
update, since the row is the actual obligation. Same pattern as the
golden tools/list contract the pre-commit hook already enforces.

The helper runs as its own process: requiring route-manager in-process
leaves open handles, and the module-loading glob runs without --exit, so
an in-process version would stall the suite. It reads app._router --
app.router without the underscore is a throwing deprecation getter in
express 4 -- and exits 2 if those internals move, so a future express
upgrade fails loudly instead of reporting an empty inventory that would
pass forever.

Includes a negative case (the inventory must be non-empty and contain
known-live routes); the added-route failure path was verified by hand
with a temporary canary route.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/cross-cutting-matrix.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1–4 complete.
- Produces: nothing.

- [ ] **Step 1: Rewrite the OpenStack row in `docs/cross-cutting-matrix.md`**

Line 60 currently reads `➖ exempt, deliberately and by design`. **Rewrite it, do not delete it** — the matrix's own rule is that a missing row is worse than a blank cell, and the 5.0.0 event-channel row (line 40) and the 7.0.0 `/callbacks` row (line 58) are the precedents for keeping a removed path's history visible. Follow line 58's shape:

> | **OpenStack simulation routes** | ➖ **removed in 7.0.0.** Mounted ahead of `lib/routes/user.js` with no authentication at all, the code saying so at the mount point ("openstack api simulation don't do user auth"), and reachable whenever `--simOpenStackAPI` was set. It was removed as a vestigial simulation shim, not as a working feature: `createServer.js` hardcoded a single 2015 China Mobile target — deviceID `46932cf8-07f0-501b-9491-120ae4efd2c2`, `serviceID` `urn:10086-cn:serviceID:弹性计算服务`, action `云主机创建` — so it could only ever have driven one specific vendor module that this repo does not ship. The `--simOpenStackAPI` flag is gone with it; an unknown flag is ignored, so a startup script still passing it boots normally and gets no route. Test: `test/auth/16-removed-iot-routes.js` (auth 16b) | ➖ | ➖ | ➖ | ➖ | ➖ |

- [ ] **Step 2: Add rows for the other removed paths**

Add one row per removed path in the same `➖ removed in 7.0.0` style, each naming why it could not work: `/devices/:deviceID/connect`, `/devices/:deviceID/disconnect`, `/discover`, `/stop-discover`, `/devices/:deviceID/presentation`, `/load-profile`. Draw the reasons from the spec's Group 1 and Group 2 sections — each one names the method that was never defined, or the flag that was hardcoded false.

- [ ] **Step 3: Add the CHANGELOG entry**

Under the existing `## 7.0.0 (unreleased)` heading in `CHANGELOG.md`, add a section in the style of the existing `### Removed — the dead device-callback entry path`:

```markdown
### Removed — the IoT-era HTTP surface

- **The dead entry paths are gone**: `/devices/:deviceID/connect` and
  `/disconnect` (both called a `CdifInterface` method that was never
  defined, so every POST threw `TypeError`), `/discover` and
  `/stop-discover` (mounted only under `allowDiscover`, which
  `cli-options.js` hardcoded to `false`), and
  `/devices/:deviceID/presentation` (dead twice over — nothing emitted the
  event that mounts it, and the mount handler called an undefined method).
  Breaking on paper; no behavior change in fact.
- **The vestigial flag-gated surface is gone**, and this one *is* a
  behavior change: the OpenStack simulation (`--simOpenStackAPI`) and
  `/load-profile` (`--loadProfile`), together with both flags. The
  OpenStack routes were mounted with **no authentication at all** and
  hardcoded a single 2015 vendor target; `/load-profile` was the only
  reader of the `loadLevel` counter, which goes with it. **Unknown flags
  are ignored**, so a startup script still passing either one boots
  normally and simply gets no route.
- **`device_access_token` plumbing removed.** `ensureDeviceState` took the
  token and never read it, `lib/device-auth.js` was imported by nothing,
  and `/connect` — which would have issued one — is removed above. A
  client still sending the field is unaffected: it was already ignored.
- **Error codes removed** (both locales): `PRESENTATION_NOT_SUPPORTED`,
  `GET_DEVICE_ROOTURL_FAIL`, `PARSE_DEVICE_ROOTURL_FAIL`.
- **Capability genuinely lost:** the OpenStack-shaped simulation shim.
  Nothing else here worked.
- **Not removed, deliberately:** `/devices/:deviceID/package-info`,
  `/download-package`, `/verify-module` and `/get-module-device-list`.
  They are untested and undocumented, but they are also the only existing
  bones of the publish/listing story, so they wait on that design rather
  than being pre-decided here.
- **New guard:** `test/module-loading/11-route-inventory.js` diffs the
  mounted routes against `test/fixtures/route-inventory.json`, so a new
  entry path fails the suite until it is declared and given its
  cross-cutting-matrix row.
- Tests: `test/auth/16-removed-iot-routes.js`,
  `test/module-loading/11-route-inventory.js`.
```

- [ ] **Step 4: Verify the matrix has no stale references**

```bash
grep -nE "connect|/discover|load-profile|openstack|/v2/|presentation|device_access_token" docs/cross-cutting-matrix.md
```

Every hit must be inside a `➖ removed` row or refer to something still live (for example the direct-peer-channel row's use of "disconnect" in a different sense, and `/devices/:deviceID/get-spec`). Fix any cell that still describes a removed path as current.

- [ ] **Step 5: Run the full suite**

Docs-only, but the pre-commit hook still lints and checks the golden `tools/list`. Run the suite once more to confirm the tree is green before the final commit.

- [ ] **Step 6: Commit**

```bash
git add docs/cross-cutting-matrix.md CHANGELOG.md
git commit -m "docs(7.0.0): record the IoT-era surface removal

Rewrites the OpenStack row rather than deleting it -- a missing row is
worse than a blank cell, and the 5.0.0 event-channel and 7.0.0
/callbacks rows are the precedent for keeping a removed path's history
where the next reader will find it. Adds a row per removed path, each
naming the method that was never defined or the flag that was hardcoded
false.

CHANGELOG entry separates the three removals by how visible they are:
the dead paths change nothing, the flag-gated pair is a real behavior
change, and the token plumbing was already ignored. Also records what
was deliberately NOT removed and why, so the marketplace routes are not
mistaken for an oversight.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Group 1 → Task 1. Group 2 → Task 2. Group 3 → Task 3. "What must NOT be removed" → Task 1 Steps 6 and 7 call out the load-bearing branches explicitly, and Task 3 Step 8 flags the `CHDevice.getDeviceSpec` lookalike. Design §2 (the guard) → Task 4. Design §3 (documentation) → Task 5. "Capability genuinely lost" → Task 5 Step 3. The deferred marketplace routes appear in Global Constraints and in the CHANGELOG text so they are not silently dropped.

**Known gap, deliberate.** The spec's `test/auth/16-removed-iot-routes.js` and `test/module-loading/11-route-inventory.js` names are kept; the spec named `test/fixtures/route-inventory.json` but not the helper script — `test/fixtures/route-inventory.js` is added here because the in-process version hangs, which was discovered while prototyping and is recorded in Task 4's design note.

**Type consistency.** `ensureDeviceState(deviceID, callback)` is used identically in Task 3 Steps 5, 6 and the Task 3 Interfaces block. `readInventory()` is defined once in Task 4 Step 3 and used by all three cases in that file. `seg()`/`walk()` are defined once in the helper and not referenced from the test.

**Placeholder scan.** No TBD/TODO. Every code step carries the actual code. The one judgement-call step (Task 5 Step 2, "add one row per removed path") points at the specific spec sections that supply each reason rather than leaving the content open.
