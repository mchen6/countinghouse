# Marketplace Backend Decision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the repo match the decision that countinghouse is a self-hosted MCP runtime hosting npm-distributed modules, not a marketplace — by correcting its self-description and removing the CEAMS-era machinery that has no remaining consumer.

**Architecture:** Five commits. Three removals (each independently green, each regenerating the route-inventory golden), then test coverage plus matrix rows for the two package routes that survive, then the positioning correction and changelog. **Nothing is added to the running server** — no new tools, no new flags, no new routes.

**Tech Stack:** Node 20, express 4.22.2, mocha + supertest.

**Spec:** `docs/superpowers/specs/2026-09-04-marketplace-backend-design.md`

## Global Constraints

- **Node 20.20.2 lives at `~/.local/node-v20/bin` — put it on `PATH` first.** System `node` is v16 and will fail. `mocha` is at `./node_modules/.bin`. Use: `export PATH=$HOME/.local/node-v20/bin:$PWD/node_modules/.bin:$PATH`
- **Redis must be reachable at `redis://127.0.0.1:6379`** (`redis-cli ping` → PONG).
- **Test loop:** test1–test6 plus the globbed suites. **Skip `test7.js`** — it is a benchmark. Run it in the **FOREGROUND**, in segments if a single command times out. Do NOT background the suite and stop waiting.
- **Baseline before this plan starts:** 450 passing, 3 pending, 0 failing, at master `e22f83e`.
- **One task per commit. Run the suite before each commit.**
- **A pre-commit hook runs `eslint` and asserts `tools/list` is byte-identical to the golden sample.** Nothing here should move the MCP surface — none of these routes contributes a tool.
- **eslint enforces `prefer-arrow-callback` and `prefer-template`.** Use `describe(..., function() {...})` only when the block calls `this.timeout(...)`; otherwise use an arrow function.
- **All new docs and code comments in English.**
- **Never delete `adaptive-test/`, `perf/`, `spec/`.**
- **`options.verifyModule` (the FLAG) must survive.** Only `ModuleManager.prototype.verifyModule` (the METHOD) is removed. See Task 1.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/route-manager.js` | Single mount point for every HTTP entry path | 1, 2 |
| `lib/module-manager.js` | `verifyModule` tarball parser (removed) | 1 |
| `lib/error-info.{en-US,zh-CN}.json` | Error catalogue, both locales | 1 |
| `test/auth/06-admin-gating.js` | Admin-gate coverage; lists `/verify-module` | 1 |
| `lib/countinghouse-interface.js`, `lib/device-manager.js` | `getDevicePackageModulePath` chain (removed) | 2 |
| `lib/cli-options.js` | `--regUrl` (removed) | 3 |
| `package.json` | Orphaned deps; description; keyword | 1, 3, 5 |
| `test/auth/17-removed-package-routes.js` | 404 regression + surviving-route coverage | 1, 2, 4 |
| `test/fixtures/route-inventory.json` | Golden inventory | 1, 2 |
| `docs/cross-cutting-matrix.md` | Per-path guarantee record | 4 |
| `server.json`, `docs/security-model.md`, `CHANGELOG.md` | Positioning and the record | 5 |

Deleted: `lib/routes/verify-module.js`, `lib/routes/download-device-package.js`. (`example/publish-api.js` was originally listed here; it is untracked, so there is nothing to delete — see Task 3 Step 1.)

---

### Task 1: Remove `/verify-module` and the tarball verifier

**Files:**
- Create: `test/auth/17-removed-package-routes.js`
- Modify: `lib/route-manager.js`, `lib/module-manager.js`, `lib/error-info.en-US.json`, `lib/error-info.zh-CN.json`, `test/auth/06-admin-gating.js`, `test/fixtures/route-inventory.json`, `package.json`
- Delete: `lib/routes/verify-module.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `test/auth/17-removed-package-routes.js`, extended by Tasks 2 and 4. Port `9549` is claimed by this file (verified unused: used ports are 9530–9531, 9541–9548, 9550–9564, 9574–9575, 9584–9595).

- [ ] **Step 1: Write the failing test**

Create `test/auth/17-removed-package-routes.js`:

```js
const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

// The CEAMS-era package routes. countinghouse was the verification half of
// CEAMS, an external all-in-one API package platform (now retired) that
// published verified packages to CouchDB and listed them on its own website.
// With CEAMS gone and npm as the distribution channel, two of those four
// routes have no remaining consumer:
//
//   POST /verify-module -- parsed an uploaded .tgz (package.json, api.json,
//     schema.json). Superseded by countinghouse_validate_module, which runs
//     the validator in a CHILD PROCESS, cross-checks the handler map too, and
//     reports every problem rather than the first. npm untars, so a tarball
//     parser has no job.
//   GET /devices/:deviceID/download-package -- packaged a loaded module for
//     download, which was CEAMS's download step. npm serves packages now.
//
// The other two survive and are covered further down this file.
const PORT             = 9549;
const url              = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-auth-17-${process.pid}.json`;

const ADMIN = `admin-key-17-${process.pid}`;

describe('auth 17: the CEAMS-era package routes with no consumer are gone', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    const config = {};
    config[ADMIN] = {userName: 'admin17', devices: ['*'], admin: true};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse for removed-package-route test...');
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
    request(url).get('/balance').set('X-CH-Key', ADMIN).expect(200, done);
  });

  it('POST /verify-module is 404', (done) => {
    request(url).post('/verify-module')
                .set('X-CH-Key', ADMIN)
                .set('Content-Type', 'application/json')
                .send({name: '/tmp/whatever.tgz', path: '/tmp'})
                .expect(404, done);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH=$HOME/.local/node-v20/bin:$PWD/node_modules/.bin:$PATH
mocha ./test/auth/17-removed-package-routes.js
```

Expected: the guard case passes; the `/verify-module` case FAILS — the route is mounted and answers something other than 404 for an admin key.

- [ ] **Step 3: Delete the route file and its mount**

```bash
git rm lib/routes/verify-module.js
```

In `lib/route-manager.js`, delete this line from `installNormalRoutes`:

```js
  this.app.use('/verify-module', adminOnly, require('./routes/verify-module')(this.moduleManager, this.cdifInterface));
```

- [ ] **Step 4: Delete `ModuleManager.prototype.verifyModule`**

In `lib/module-manager.js`, delete the whole method. It begins at:

```js
ModuleManager.prototype.verifyModule = function(input, callback) {
```

and ends immediately before:

```js
ModuleManager.prototype.loadModuleUnsafe = function(modulePath, name, version, packageInfo, apiDesignID, callback) {
```

(roughly lines 633–744 — locate by those two anchors, not by number). Its only caller was the route deleted in Step 3; confirm with `grep -rn "verifyModule" lib/ bin/ framework.js` afterwards, expecting hits only on `options.verifyModule`.

**DO NOT remove `options.verifyModule`.** It is an unrelated flag that drives fall-through behavior at `lib/device-manager.js:142,162,166,183` and gates `--debug --verifyModule` reporting at `lib/countinghouse-util.js:174,283`. Same name, different thing. Removing it breaks module verification.

- [ ] **Step 5: Remove the `tar` dependency**

`require('tar')` appeared only inside the method just deleted (`lib/module-manager.js:648`, used at `:668`). Confirm it is now unreferenced:

```bash
grep -rn "require('tar')" lib/ bin/ framework.js example/ | grep -v node_modules
```

Expected: no output. Then remove `"tar"` from `dependencies` in `package.json`. Do **not** run `npm install` or otherwise rewrite `package-lock.json` — leave lockfile regeneration to a deliberate dependency pass.

- [ ] **Step 6: Remove the six now-unreachable error codes from both locales**

These six were used only by the deleted method (verified: zero other uses in `lib/`, `test/`, or `docs/`):

```
MODULE_INSTALL_PATH_PREFIX_INVALID
MODULE_NAME_TYPE_ERROR
MODULE_PACKAGE_INFO_TYPE_ERROR
READ_MODULE_FAIL
UNTAR_MODULE_FAIL
UNZIP_MODULE_FAIL
```

Remove each from **both** `lib/error-info.en-US.json` and `lib/error-info.zh-CN.json`. The two files must stay key-for-key in sync.

**Keep `MODULE_INSTALL_FAIL` and `MODULE_PACKAGE_INFO_INVALID`** — both have other callers.

Verify sync afterwards:

```bash
node -e "
const en=Object.keys(require('./lib/error-info.en-US.json'));
const zh=Object.keys(require('./lib/error-info.zh-CN.json'));
console.log('en',en.length,'zh',zh.length);
console.log('only en:',en.filter(k=>!zh.includes(k)));
console.log('only zh:',zh.filter(k=>!en.includes(k)));"
```

Expected: equal counts, both difference lists empty.

- [ ] **Step 7: Drop `/verify-module` from the admin-gating test**

`test/auth/06-admin-gating.js:48-54` has:

```js
  const ADMIN_ONLY_ROUTES = [
    '/load-module', '/unload-module', '/restart-module',
    '/verify-module', '/get-module-device-list', '/reload-module'
```

Remove `'/verify-module', ` from that array, leaving the other five. This file runs 3 `it` blocks per route, so this removes exactly 3 tests.

- [ ] **Step 8: Regenerate the route-inventory golden**

```bash
node ./test/fixtures/route-inventory.js > ./test/fixtures/route-inventory.json
git diff test/fixtures/route-inventory.json
```

Expected: exactly one line removed, `"/verify-module"`. If anything else changed, stop and investigate — this task removes one route.

- [ ] **Step 9: Run the new and affected tests**

```bash
mocha ./test/auth/17-removed-package-routes.js
mocha ./test/module-loading/11-route-inventory.js
mocha ./test/auth/06-admin-gating.js
```

Expected: 2 passing, 3 passing, and 06-admin-gating passing with 3 fewer cases than before.

- [ ] **Step 10: Run the full suite**

```bash
mocha ./test/test1.js && mocha ./test/test2.js && mocha ./test/test3.js && \
mocha ./test/test4.js && mocha --exit ./test/test5.js && \
mocha ./test/auth/*.js ./test/device-config/*.js ./test/module-loading/*.js \
      ./test/spec-format/*.js ./test/mcp-contract/*.js ./test/validation/*.js \
      ./test/module-authoring/*.js && \
mocha --exit ./test/composition/*.js && mocha ./test/test8.js && \
npm run test:peer-standalone && mocha ./test/test6.js
```

Expected: **449 passing**, 3 pending, 0 failing. (450 baseline − 3 admin-gating cases + 2 new cases.)

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "remove(7.0.0): /verify-module and the tarball verifier

countinghouse was the verification half of CEAMS, an external API
package platform that uploaded a .tgz here to be checked. CEAMS is
retired and npm is the distribution channel, so a tarball parser has
no remaining job -- npm untars.

It is also superseded on every axis by countinghouse_validate_module,
which runs the validator in a child process rather than in-process,
cross-checks api.json, schema.json AND the handler map against each
other rather than parsing three files, and reports every problem
rather than the first.

Takes with it six error codes with no other caller and the 'tar'
dependency, whose only require lived inside the deleted method.

NOT removed: options.verifyModule, an unrelated flag of the same name
that drives module-verification fall-through in device-manager.js and
countinghouse-util.js.

Test: test/auth/17-removed-package-routes.js

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Remove `/download-package` and its chain

**Files:**
- Modify: `test/auth/17-removed-package-routes.js`, `lib/route-manager.js`, `lib/countinghouse-interface.js`, `lib/device-manager.js`, `test/fixtures/route-inventory.json`
- Delete: `lib/routes/download-device-package.js`

**Interfaces:**
- Consumes: `test/auth/17-removed-package-routes.js` from Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` block in `test/auth/17-removed-package-routes.js`, after the `/verify-module` case:

```js
  it('GET /devices/:deviceID/download-package is 404', (done) => {
    request(url).get('/devices/some-device-id/download-package')
                .set('X-CH-Key', ADMIN)
                .expect(404, done);
  });
```

The admin key has `devices: ['*']`, and FileAuthProvider authorizes any deviceID under a wildcard without resolving it against the live device set — so `validateUser` calls `next()` and an unmounted path falls through to 404 rather than erroring at the auth gate.

- [ ] **Step 2: Run the test to verify it fails**

```bash
mocha ./test/auth/17-removed-package-routes.js
```

Expected: the new case FAILS — the route is still mounted.

- [ ] **Step 3: Delete the route file and its mount**

```bash
git rm lib/routes/download-device-package.js
```

In `lib/route-manager.js`, delete:

```js
  this.deviceControlRouter.use('/:deviceID/download-package', require('./routes/download-device-package')(this.moduleManager, this.cdifInterface));
```

- [ ] **Step 4: Delete the interface method**

In `lib/countinghouse-interface.js`, delete (currently ~line 154):

```js
CdifInterface.prototype.getDevicePackageModulePath = function(deviceID, callback) {
  this.deviceManager.emit('getdevicepackagemodulepath', deviceID, callback);
};
```

- [ ] **Step 5: Delete the device-manager handler and its event binding**

In `lib/device-manager.js`, delete the binding (currently ~line 95):

```js
  this.on('getdevicepackagemodulepath',   this.onGetDevicePackageModulePath.bind(this));
```

and the whole `DeviceManager.prototype.onGetDevicePackageModulePath` method (currently starting ~line 100), which ends where `DeviceManager.prototype.onGetDevicePackageInfo` begins. **Do not touch `onGetDevicePackageInfo`** — that backs `/devices/:deviceID/package-info`, which survives and is covered in Task 4.

There is also a comment at `lib/device-manager.js:799` referencing `onGetDevicePackageModulePath` ("...already makes."). Update it so it does not point at a deleted method; keep whatever point it was making about the check itself.

- [ ] **Step 6: Confirm the chain is fully gone**

```bash
grep -rn "getDevicePackageModulePath\|getdevicepackagemodulepath\|onGetDevicePackageModulePath" lib/ test/ | grep -v node_modules
```

Expected: no output.

Note `rimraf` was required by the deleted route file but is **also** used by `lib/module-manager.js`, so it stays a dependency. Verify:

```bash
grep -rn "require('rimraf')" lib/ | grep -v node_modules
```

Expected: one hit, in `lib/module-manager.js`.

- [ ] **Step 7: Regenerate the golden**

```bash
node ./test/fixtures/route-inventory.js > ./test/fixtures/route-inventory.json
git diff test/fixtures/route-inventory.json
```

Expected: exactly one line removed, `"/devices/:deviceID/download-package"`.

- [ ] **Step 8: Run the full suite**

Same command as Task 1 Step 10. Expected: **450 passing**, 3 pending, 0 failing (449 + 1 new case).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "remove(7.0.0): /download-package and its chain

It packaged a loaded module into a tarball for someone to download --
CEAMS's download step. CEAMS is retired, and under npm distribution the
registry serves packages, so nothing consumes this.

Removes the route, CdifInterface.getDevicePackageModulePath,
DeviceManager.onGetDevicePackageModulePath and the
getdevicepackagemodulepath event. onGetDevicePackageInfo is untouched --
it backs /devices/:deviceID/package-info, which survives.

Test: test/auth/17-removed-package-routes.js

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Remove the publish remnant and `--regUrl`

**Files:**
- Modify: `lib/cli-options.js`, `package.json`
- (Originally listed `example/publish-api.js` for deletion. Corrected: that file is NOT tracked — `.gitignore:25` covers `example/` since commit 182db48 — so there is nothing to delete. See Step 1.)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

No test changes: this removes an example script and an unread option. The suite count must be **unchanged**, which is itself the assertion — if it moves, something was load-bearing that this task assumed was not.

- [ ] **Step 1: Confirm the publish remnant is unreferenced and already broken**

```bash
grep -rn "publish-api" . --include=*.js --include=*.json --include=*.md 2>/dev/null | grep -v node_modules
node -e "console.log('request in deps:', 'request' in require('./package.json').dependencies)"
```

Expected: no references outside the file itself, and `request in deps: false` — the script `require`s a package that is not installed, so it could not run even if invoked. If `request` IS a dependency, stop and report: the analysis behind this task is wrong.

- [ ] **Step 2: Delete it**

**Nothing to delete.** `example/` has been gitignored and untracked since commit
`182db48`, so `git rm` would fail and a plain `rm` would destroy maintainer-local
material while producing no diff. Confirm and move on:

```bash
git check-ignore -v example/publish-api.js   # expect: .gitignore:25:example/
git cat-file -e HEAD:example/publish-api.js || echo "not tracked — nothing to remove"
```

`nano` is NOT in `dependencies` at all (verified 2026-09-04) and does not resolve, even though `lib/couchdb-adapter/couchdb-auth-provider.js:33` and `init-db.js:43` require it — both lazily, inside functions, which is why the suite passes and `test/auth/04-couchdb-provider.js` is among the 3 pending. That is a pre-existing defect, out of scope here; the point for this task is simply that there is no `nano` entry to remove. Verify:

```bash
grep -rln "require('nano')" lib/ | grep -v node_modules
```

Expected: the two couchdb-adapter files.

- [ ] **Step 3: Remove `--regUrl`**

In `lib/cli-options.js`, delete the assignment (currently line 37):

```js
    this.regUrl       = argv.regUrl     || 'http://127.0.0.1:8037/';
```

and its entry in `getOptions()` (currently line 124):

```js
      regUrl:                   this.regUrl,
```

Its only consumer was `ModuleManager.verifyModule`, removed in Task 1. Confirm:

```bash
grep -rn "regUrl" lib/ bin/ framework.js test/ | grep -v node_modules
```

Expected: no output.

- [ ] **Step 4: Remove the orphaned `npm-registry-client` dependency**

It is required nowhere in the repo — it was the client for the kappa private registry `--regUrl` pointed at. Confirm, then remove `"npm-registry-client"` from `dependencies` in `package.json`:

```bash
grep -rn "npm-registry-client" lib/ bin/ framework.js example/ test/ | grep -v node_modules
```

Expected: no output. Again, do not regenerate `package-lock.json`.

- [ ] **Step 5: Run the full suite**

Same command as Task 1 Step 10. Expected: **450 passing**, 3 pending, 0 failing — **unchanged from Task 2**. A change here means something depended on `--regUrl` or the example; investigate before committing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "remove(7.0.0): the CouchDB publish remnant and --regUrl

The 2015 CouchDB publish path (example/publish-api.js) needed no removal
here: commit 182db48 untracked all of example/, so it already sits
outside what this repo ships. Recorded so the next reader does not
re-derive it.

--regUrl defaulted to http://127.0.0.1:8037/, the old kappa private
registry, and its only reader was the verifyModule method removed
earlier in this branch. CLAUDE.md had already decided to drop the
private registry dependency entirely; this is its last trace, together
with npm-registry-client, which no file requires.

nano stays -- lib/couchdb-adapter/ still uses it for the CouchDB
AuthProvider.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Cover the two surviving routes, and give them matrix rows

The spec keeps `/get-module-device-list` and `/devices/:deviceID/package-info`. Neither has ever had a test, and neither has ever had a `docs/cross-cutting-matrix.md` row. Adding a row that asserts behavior nothing checks would be worse than no row, so the test comes first.

**Files:**
- Modify: `test/auth/17-removed-package-routes.js`, `docs/cross-cutting-matrix.md`

**Interfaces:**
- Consumes: `test/auth/17-removed-package-routes.js` from Tasks 1–2 (its `ADMIN` key already has `devices: ['*'], admin: true`, and the server is started with `--loadModule ./pre-installed-packages/echo-device-module`).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

These assert *current, working* behavior, so they should pass immediately — the point is to lock it in before the matrix rows claim it. Append inside the same `describe` block:

```js
  // The two package routes that survive. Both are covered here because Task 4
  // adds their cross-cutting-matrix rows, and a row asserting behavior that
  // nothing tests is worse than a blank cell.

  it('POST /get-module-device-list returns a loaded module device list', (done) => {
    request(url).post('/get-module-device-list')
                .set('X-CH-Key', ADMIN)
                .set('Content-Type', 'application/json')
                .send({name: 'echo-device-module'})
                .expect(200, (err, res) => {
      if (err) return done(err);
      if (!Array.isArray(res.body) && typeof(res.body) !== 'object') {
        return done(new Error(`expected a device list object/array, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });

  it('GET /devices/:deviceID/package-info returns the module name and version', (done) => {
    request(url).get('/device-list').set('X-CH-Key', ADMIN).expect(200, (listErr, listRes) => {
      if (listErr) return done(listErr);
      const first = Array.isArray(listRes.body) ? listRes.body[0] : null;
      const deviceID = (first && first.device && first.device.deviceID) ? first.device.deviceID : null;
      if (deviceID == null) {
        return done(new Error(`could not find a deviceID in /device-list: ${JSON.stringify(listRes.body).slice(0, 400)}`));
      }
      return request(url).get(`/devices/${deviceID}/package-info`)
                         .set('X-CH-Key', ADMIN)
                         .expect(200, (err, res) => {
        if (err) return done(err);
        if (res.body == null || typeof(res.body.name) !== 'string' || typeof(res.body.version) !== 'string') {
          return done(new Error(`expected {name, version} strings, got: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
    });
  });
```

- [ ] **Step 2: Run the test**

```bash
mocha ./test/auth/17-removed-package-routes.js
```

Expected: 5 passing (2 from Task 1, 1 from Task 2, 2 added here). Both new cases should pass on the first run — they describe behavior that already works.

**If either fails**, do not adjust the assertion to match whatever the route returned. Read the route (`lib/routes/get-module-device-list.js`, `lib/routes/get-device-package-info.js`) and find out why; a surviving route that does not work is a finding worth reporting, and would change whether the spec should have kept it.

- [ ] **Step 3: Add the two matrix rows**

`docs/cross-cutting-matrix.md`'s table has 7 columns: `Entry path | userAuth (device ownership) | Schema validation | recordCall | rateLimit | Timeout | Error shape`. Every row must have exactly that many. Add these two, following the style of the existing rows:

For `/get-module-device-list` — it is mounted with `adminOnly` (`lib/route-manager.js`), takes a module name rather than a device, and is an operator endpoint. Its cells should say: admin-gated via `lib/routes/admin-only.js` requiring `isAdmin`, exempt from schema validation and `recordCall` (an operator action, not a tenant call), no rate limit (same deliberate reasoning the existing module-lifecycle row records for operator endpoints), and the standard `{topic, code, message}` error shape. Test: `test/auth/17-removed-package-routes.js`, and `test/auth/06-admin-gating.js` for the gate.

For `/devices/:deviceID/package-info` — it is under `deviceControlRouter`, so `lib/routes/user.js` → `user-auth.js` runs ahead of it, same as its device-scoped neighbours. Exempt from schema validation (no device action) and from `recordCall` (it returns package metadata, not a billed call). **Rate limit: `❌ none`** — state it plainly rather than leaving it blank; the read-path rate-limit work covered `/balance` and the `tasks/*` and job routes, and did not cover this one. Timeout: the `Session` timer, `options.requestTimeout`. Error shape: `{topic, code, message}` via `lib/session.js`. Test: `test/auth/17-removed-package-routes.js`.

- [ ] **Step 4: Update the inventory-vs-matrix paragraph**

Near the top of `docs/cross-cutting-matrix.md` is a paragraph headed **"Relationship to `test/fixtures/route-inventory.json`"**, added by the previous branch. It names five live routes that lack rows:

> `/devices/:deviceID/get-spec`, `/devices/:deviceID/schema`, `/device-list`, `/devices/:deviceID/package-info` and `/devices/:deviceID/download-package`

Two of those are now wrong: `package-info` gets a row in Step 3, and `download-package` was removed in Task 2. Update the list to the three that remain — `/devices/:deviceID/get-spec`, `/devices/:deviceID/schema`, `/device-list` — leaving the paragraph's honesty intact.

- [ ] **Step 5: Run the full suite**

Same command as Task 1 Step 10. Expected: **452 passing**, 3 pending, 0 failing (450 + 2 new cases).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(7.0.0): cover the two surviving package routes, and record them

/get-module-device-list and /devices/:deviceID/package-info both
survive the CEAMS-era cleanup: the first answers what a module loaded
at any earlier time exposes, which countinghouse_load_module's return
value cannot, and the second reports a loaded device's package name and
version.

Neither had ever had a test, and neither had ever had a
cross-cutting-matrix row. The test comes first here on purpose -- a row
asserting behavior nothing checks is worse than a blank cell, which is
this matrix's own stated rule.

Also corrects the inventory-vs-matrix paragraph: package-info now has a
row, and download-package no longer exists, leaving three live routes
still undocumented rather than five.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Correct the positioning, and record the decision

**Files:**
- Modify: `server.json`, `package.json`, `docs/security-model.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1–4 complete.
- Produces: nothing.

- [ ] **Step 1: Correct both descriptions**

`server.json:4` and `package.json:4` both read:

```
"description": "Multi-tenant runtime and monetization/marketplace backend for MCP tools",
```

The runtime half is true; the marketplace half never existed in this repo. Replace both with the same corrected text:

```
"description": "Multi-tenant runtime for MCP tools, with metering and per-key access control",
```

Both files must match exactly — `server.json` is the MCP registry manifest and `package.json` is the npm manifest; a reader comparing them should not find two different claims.

- [ ] **Step 2: Remove the `marketplace` keyword**

`package.json:46` lists `"marketplace",` among the keywords. Remove that one line, leaving the rest and the JSON valid.

- [ ] **Step 3: Clarify the security-model wording**

`docs/security-model.md:162` and `:167` use "marketplace":

> "worker-thread isolation + module review (verify/publish)" fits a **semi-trusted marketplace model** — modules are vetted by the platform operator …

> … a reasonable, low-overhead boundary for a curated marketplace of modules from developers the platform has a relationship with …

The security *position* is unchanged and correct — this design confirms it. Only the word is now misleading, since countinghouse does not operate a marketplace. Reword both to describe the same posture without implying a marketplace this project runs: operator-vetted third-party modules. Add one sentence pointing at `docs/superpowers/specs/2026-09-04-marketplace-backend-design.md` for why the framing changed, so a reader who remembers the old wording can find the decision.

- [ ] **Step 4: Add the CHANGELOG entry**

Under the existing `## 7.0.0 (unreleased)` heading in `CHANGELOG.md`, add a section in the style of the existing ones:

```markdown
### Changed — countinghouse is a runtime, not a marketplace

- **The project description is corrected** in `server.json` and
  `package.json`. It claimed to be a "monetization/marketplace backend";
  it is a multi-tenant runtime for MCP tools with metering and per-key
  access control. The marketplace half never existed in this repo.
- **Modules are distributed over npm**, to whichever npm-compatible
  registry an operator configures. countinghouse builds no publish,
  storage or browse machinery: `npm publish` is the publish story, and
  the operator installs with the tooling they already have. **The runtime
  never fetches code over the network.**
- **Removed with no replacement**: `POST /verify-module` and its tarball
  verifier (superseded by `countinghouse_validate_module`, which runs in a
  child process, cross-checks the handler map, and reports every problem);
  `GET /devices/:deviceID/download-package` and its chain (npm serves
  packages now); and `--regUrl`, the old private registry default. Six
  error codes and two dependencies (`tar`, `npm-registry-client`) went with
  them. (The 2015 CouchDB publish script needed no removal — `example/` has
  been untracked since 182db48.)
- **Kept**: `/get-module-device-list` and `/devices/:deviceID/package-info`,
  which now have tests and cross-cutting-matrix rows for the first time.
- **Consequence for payments**: settlement is between an operator and
  their own users. Module authors are not paid through countinghouse, and
  there is no revenue share, payout or escrow.
- Background and the full reasoning:
  `docs/superpowers/specs/2026-09-04-marketplace-backend-design.md`.
```

- [ ] **Step 5: Verify the JSON files still parse**

```bash
node -e "require('./package.json'); require('./server.json'); console.log('both parse')"
```

- [ ] **Step 6: Run the full suite**

Same command as Task 1 Step 10. Expected: **452 passing**, 3 pending, 0 failing — unchanged from Task 4, since this task is documentation and manifest text.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs(7.0.0): countinghouse is a runtime, not a marketplace

server.json and package.json both claimed 'Multi-tenant runtime and
monetization/marketplace backend for MCP tools'. The runtime half is
true. The marketplace half never existed here -- the code that gestured
at it was a 2015 CouchDB script requiring a package this project does
not depend on.

Corrects both descriptions to the same text, drops the marketplace
keyword, and rewords security-model.md's 'semi-trusted marketplace
model' to say what it actually means -- operator-vetted third-party
modules -- without implying a marketplace this project operates. The
security position itself is unchanged; this design confirms it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** D1/D2 need no code (they are positioning, recorded in Task 5's CHANGELOG). D3 → Task 3 (`--regUrl`, publish remnant) and Task 5 (the npm distribution statement). D4 → Task 5's CHANGELOG bullet ("the runtime never fetches code"); it builds nothing, which is the point. D5 → Task 5's payments bullet. Design §1 Positioning → Task 5. §2 One validator → Task 1. §3 Removals → Tasks 1, 2, 3, and the surviving-routes half → Task 4. Testing section → Tasks 1, 2, 4. "What this forecloses" → recorded in the spec itself and summarized in Task 5's CHANGELOG.

**Deliberate additions beyond the spec's file list.** The spec did not name `test/auth/06-admin-gating.js`, the `tar` and `npm-registry-client` dependencies, or the six error codes. All four were found while writing this plan by grepping for what the removals orphan, and all are required for the branch to be green and complete. The `lib/device-manager.js:799` comment update in Task 2 Step 5 is the same category.

**Placeholder scan.** No TBD/TODO. Every code step carries the code. Task 4 Step 3 and Task 5 Step 3 describe prose to write rather than quoting it verbatim, but both name the exact file, the exact lines, the required column count or wording constraint, and the substance each cell or sentence must carry — a reviewer can check the result against those.

**Type consistency.** `test/auth/17-removed-package-routes.js` uses one `describe`, one `ADMIN` key, and one `url`/`PORT` pair across Tasks 1, 2 and 4; later tasks append cases and never redeclare them. Expected suite counts chain correctly: 450 → 449 (Task 1: −3 admin-gating, +2 new) → 450 (Task 2: +1) → 450 (Task 3: +0) → 452 (Task 4: +2) → 452 (Task 5: +0).
