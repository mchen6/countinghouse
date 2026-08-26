# Module Composition API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A module calls another module by name — `await ctx.call('repo-scan/scanService.scan', input)` — instead of pasting a UUID v5 device ID, a service URN and an identity string into its handler.

**Architecture:** An address is `<friendlyName>/<serviceLabel>.<action>`. The device half resolves by pure function (UUID v5, the same derivation `CHDevice` uses); the service half needs the target's spec, fetched over the existing `querydevice` worker message, which already queues while discovery is in flight. What a module may call is declared in its own `package.json` under `countinghouse.calls`; which identity it runs as is declared separately in auth config via `runsModules`, because that is the operator's decision. The device spec format does not change.

**Tech Stack:** Node.js >= 20, CommonJS, mocha + `assert`, ajv 8 (JSON Schema 2020-12), `uuid-1345`, sqlite3 (optional auth backend), Redis (metering/session).

**Spec:** `docs/superpowers/specs/2026-08-24-module-composition-api-design.md`

## Global Constraints

- Node >= 20. Run everything with `export PATH="$HOME/.local/node-v20/bin:$PATH"` — the system `/usr/bin/node` is v16 and will fail. Run `npm install` and `npm test` under the same Node binary; switching versions without `npm rebuild sqlite3` breaks the native binding.
- Redis must be reachable at `redis://127.0.0.1:6379` for any test that starts a server. Check with `docker exec competent_leakey redis-cli ping` — the host's own `redis-cli` is too old and misreports.
- One task per commit. Run the functional suite before each commit; **do not** run `test/test7.js` (benchmark) during iteration.
- All new code comments and docs in English.
- Never delete or edit `adaptive-test/`, `perf/`, `spec/` fixtures. `spec/schema.json` is **not** modified by this plan at all.
- Test ports: use **9556, 9557, 9558** only. Occupied elsewhere in `test/`: 9000, 9527, 9530–9531, 9541–9546, 9550–9554, 9571–9575, 9584, 9586, 9590–9591, 9593, 9595, 9811.
- `npm run golden` must stay byte-identical throughout. `test/auth/13-ctx-billing-identity.js` must keep passing untouched — it is the proof `ctx.serviceClient` is unchanged.
- Never merge a new field into the `data` object that crosses a cross-worker reply. `platformMetering` rides as a third callback argument; keep it there.
- Branch: `feat/module-composition-api`. Do not commit to `master`.

---

## File Structure

**New files**

- `lib/device-id-conflict.js` — decides whether an incoming device registration collides with a different module's. No `require`s, so tests load it without starting anything.
- `lib/call-address.js` — parse an address, derive a deviceID from a `friendlyName`, resolve a parsed address against a target spec. No `require`s except `uuid-1345`, for the same reason.
- `test/composition/00-duplicate-device-id.js`, `01-call-address.js`, `02-ctx-call.js`, `03-declaration.js`, `04-failure-and-billing.js`, `05-module-identity.js`.
- `test/fixtures/dup-name-a/`, `test/fixtures/dup-name-b/` — two modules sharing a `friendlyName`.
- `test/fixtures/compose-caller/`, `test/fixtures/compose-callee/` — a two-module chain used by tasks 4–6.

**Modified**

- `lib/device-manager.js` — both registration sites; load-time verification.
- `lib/countinghouse-device.js:32` — UUID derivation moves out, is called back in.
- `lib/countinghouse-util.js` — add `queryDeviceSpec`.
- `lib/handler-ctx.js` — add `ctx.call`.
- `lib/auth/provider.js`, `lib/auth/file-provider.js`, `lib/auth/sqlite-provider.js` — `identityForModule`.
- `lib/plan-validator.js`, `lib/module-validator.js` — declaration checking.
- `examples/repo-review/repo-review/{package.json,handlers/reviewService/review.js}`, `examples/repo-review/auth.json`.
- `package.json` — add `./test/composition/*.js` to the `test` script.
- `docs/composite-tools.md`, `docs/module-authoring.md`, `docs/module-development.md`.

---

### Task 1: Refuse a duplicate deviceID from a different module

The prerequisite. `deviceID` is UUID v5 of `friendlyName`, so two modules choosing the same name collide. Worker mode (`lib/device-manager.js:464`) has no check; single-thread mode (`:168-173`) has one whose test is inverted — it refuses the *same* module and lets a *different* one overwrite.

**Files:**
- Create: `lib/device-id-conflict.js`
- Create: `test/composition/00-duplicate-device-id.js`
- Modify: `lib/device-manager.js:168-173`, `lib/device-manager.js:459-465`

**Interfaces:**
- Consumes: nothing.
- Produces: `require('./device-id-conflict').conflictingModulePath(existingEntry, incomingModulePath)` → `string | null`. Returns the existing entry's `modulePath` when it belongs to a different module, `null` when there is no entry or it is the same module re-registering.

- [ ] **Step 1: Write the failing test**

Create `test/composition/00-duplicate-device-id.js`:

```js
// deviceID is UUID v5 of friendlyName, so two modules that pick the same
// friendlyName collide on ID. This is the rule that decides whether a
// registration is a collision (refuse) or a reload (allow).
const assert = require('assert');
const conflict = require('../../lib/device-id-conflict');

describe('device-id-conflict', () => {
  it('reports no conflict when nothing is registered', () => {
    assert.strictEqual(conflict.conflictingModulePath(null, '/modules/a'), null);
    assert.strictEqual(conflict.conflictingModulePath(undefined, '/modules/a'), null);
  });

  it('allows the same module to re-register (reload)', () => {
    const existing = {modulePath: '/modules/a'};
    assert.strictEqual(conflict.conflictingModulePath(existing, '/modules/a'), null);
  });

  it('reports the existing module path when a different module collides', () => {
    const existing = {modulePath: '/modules/a'};
    assert.strictEqual(conflict.conflictingModulePath(existing, '/modules/b'), '/modules/a');
  });

  it('treats an unknown existing modulePath as a conflict', () => {
    // An entry we cannot attribute is not safe to overwrite silently.
    assert.strictEqual(conflict.conflictingModulePath({}, '/modules/b'), '<unknown>');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
export PATH="$HOME/.local/node-v20/bin:$PATH"
npx mocha ./test/composition/00-duplicate-device-id.js
```

Expected: FAIL — `Cannot find module '../../lib/device-id-conflict'`.

- [ ] **Step 3: Write the implementation**

Create `lib/device-id-conflict.js`:

```js
// Whether an incoming device registration collides with one already held.
//
// deviceID is UUID v5 of the spec's friendlyName (lib/countinghouse-device.js),
// so two unrelated modules that happen to choose the same friendlyName produce
// the same deviceID. Before this file, worker mode overwrote the first
// silently and single-thread mode had the test backwards.
//
// Lives alone with no requires so it can be unit-tested without loading
// device-manager.js, which pulls in the whole runtime.
//
// Same module re-registering is NOT a conflict: module reload depends on
// replacing its own entry.
function conflictingModulePath(existingEntry, incomingModulePath) {
  if (existingEntry == null) return null;

  const existingPath = existingEntry.modulePath;
  if (existingPath == null) return '<unknown>';
  if (existingPath === incomingModulePath) return null;

  return existingPath;
}

module.exports = {
  conflictingModulePath: conflictingModulePath
};
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx mocha ./test/composition/00-duplicate-device-id.js
```

Expected: PASS, 4 passing.

- [ ] **Step 5: Wire the single-thread registration site**

In `lib/device-manager.js`, add near the other requires at the top of the file:

```js
const deviceIdConflict = require('./device-id-conflict');
```

Replace lines 168–173 (the inverted guard) with:

```js
    const existingConflict = deviceIdConflict.conflictingModulePath(this.deviceMap[uuid], modulePath);
    if (existingConflict != null) {
      LOG.DE(cdifDevice, new CHError('DEVICE_OBJECT_CONFLICT',
        `friendlyName "${cdifDevice.spec.device.friendlyName}" is already registered by ${
        existingConflict} -- deviceID ${uuid} is derived from friendlyName, so two modules ` +
        'cannot share one. Rename one of them.'));
      if (options.verifyModule !== true) return;      // fall through in case we are verifying a module
    }
```

- [ ] **Step 6: Wire the worker-mode registration site**

In `lib/device-manager.js`, replace the `if (deviceID != null) { ... }` block at lines 459–465 with:

```js
    if (deviceID != null) {
      const existingConflict = deviceIdConflict.conflictingModulePath(this.deviceMap[deviceID], modulePath);
      if (existingConflict != null) {
        LOG.E(new CHError('DEVICE_OBJECT_CONFLICT',
          `friendlyName "${spec.device.friendlyName}" is already registered by ${
          existingConflict} -- deviceID ${deviceID} is derived from friendlyName, so two ` +
          'modules cannot share one. Rename one of them.'));
        return;
      }
      //instead of cdifDevice we save workerMessage instance to deviceMap so we can send msg to it
      //in case one module contains multiple devices,
      //one wm.deviceList can hold multiple deviceID, and multiple deviceMap[deviceID] can refer to the same wm instance
      this.deviceMap[deviceID] = wm;
    }
```

- [ ] **Step 7: Run lint and the functional suite**

```bash
npm run lint
npx mocha ./test/test1.js && npx mocha ./test/test2.js && npx mocha ./test/test3.js && \
npx mocha ./test/test4.js && npx mocha --exit ./test/test5.js && npx mocha ./test/test6.js
npx mocha ./test/auth/*.js ./test/module-loading/*.js
npm run golden
```

Expected: all pass; golden byte-identical. `DEVICE_OBJECT_CONFLICT` is asserted by no existing test, so changing its semantics breaks nothing.

- [ ] **Step 8: Commit**

```bash
git add lib/device-id-conflict.js lib/device-manager.js test/composition/00-duplicate-device-id.js
git commit -m "fix: refuse a deviceID already registered by a different module

deviceID is UUID v5 of friendlyName, so two modules picking the same name
collide. Worker mode overwrote the first silently; single-thread mode had
the test inverted, refusing same-module re-registration and permitting
cross-module takeover. Both now refuse a different module and allow a
reload, naming the module that holds the name."
```

---

### Task 2: `lib/call-address.js` — parse and resolve an address

**Files:**
- Create: `lib/call-address.js`
- Create: `test/composition/01-call-address.js`
- Modify: `lib/countinghouse-device.js:32`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all from `require('./call-address')`:
  - `parseAddress(address)` → `{device, service, action}` or `null`
  - `deviceIDForName(friendlyName)` → uuid string
  - `resolveAddress(spec, parsed)` → `{ok: true, serviceID}` or `{ok: false, message}`
  - `ADDRESS_FORM` → the string `'<module>/<service>.<action>'`

- [ ] **Step 1: Write the failing test**

Create `test/composition/01-call-address.js`:

```js
// Pure cover for lib/call-address.js: no server, no Redis, no worker.
// The UUID assertion is the load-bearing one -- if this file's derivation
// ever drifts from CHDevice's, every address resolves to a device that
// does not exist.
const assert = require('assert');
const UUID   = require('uuid-1345');
const addr   = require('../../lib/call-address');

describe('call-address: parsing', () => {
  it('splits a well-formed address', () => {
    assert.deepStrictEqual(addr.parseAddress('repo-scan/scanService.scan'),
      {device: 'repo-scan', service: 'scanService', action: 'scan'});
  });

  it('rejects a missing service or action', () => {
    assert.strictEqual(addr.parseAddress('repo-scan'), null);
    assert.strictEqual(addr.parseAddress('repo-scan/scanService'), null);
    assert.strictEqual(addr.parseAddress('repo-scan.scan'), null);
  });

  it('rejects extra delimiters rather than guessing', () => {
    assert.strictEqual(addr.parseAddress('a/b/c.d'), null);
    assert.strictEqual(addr.parseAddress('a/b.c.d'), null);
    assert.strictEqual(addr.parseAddress('a.b/c.d'), null);
  });

  it('rejects empty parts and non-strings', () => {
    assert.strictEqual(addr.parseAddress('/b.c'), null);
    assert.strictEqual(addr.parseAddress('a/.c'), null);
    assert.strictEqual(addr.parseAddress('a/b.'), null);
    assert.strictEqual(addr.parseAddress(null), null);
    assert.strictEqual(addr.parseAddress(42), null);
  });
});

describe('call-address: deviceID derivation', () => {
  it('matches the derivation CHDevice uses', () => {
    // Duplicated here on purpose: this literal is the contract. If someone
    // changes call-address.js's seed, this fails instead of every address
    // silently resolving to nothing.
    const expected = UUID.v5({
      namespace: UUID.namespace.url,
      name: 'https://registry.apemesh.com/packages/repo-scan'
    });
    assert.strictEqual(addr.deviceIDForName('repo-scan'), expected);
  });

  it('is the ID repo-scan actually has in the demo', () => {
    assert.strictEqual(addr.deviceIDForName('repo-scan'), '1359302a-e4fe-5c14-853b-f83638e8ca01');
  });
});

describe('call-address: resolving against a spec', () => {
  const spec = {device: {friendlyName: 'repo-scan', serviceList: {
    'urn:countinghouse-com:serviceID:scanService': {actionList: [{name: 'scan'}, {name: 'peek'}]}
  }}};

  it('resolves a service label to its full URN', () => {
    const r = addr.resolveAddress(spec, addr.parseAddress('repo-scan/scanService.scan'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.serviceID, 'urn:countinghouse-com:serviceID:scanService');
  });

  it('names the available services when the label matches none', () => {
    const r = addr.resolveAddress(spec, addr.parseAddress('repo-scan/nopeService.scan'));
    assert.strictEqual(r.ok, false);
    assert.ok(/nopeService/.test(r.message));
    assert.ok(/scanService/.test(r.message), 'message should list what does exist');
  });

  it('refuses an ambiguous label rather than picking one', () => {
    const ambiguous = {device: {friendlyName: 'x', serviceList: {
      'urn:vendor-a:serviceID:scanService': {actionList: [{name: 'scan'}]},
      'urn:vendor-b:serviceID:scanService': {actionList: [{name: 'scan'}]}
    }}};
    const r = addr.resolveAddress(ambiguous, addr.parseAddress('x/scanService.scan'));
    assert.strictEqual(r.ok, false);
    assert.ok(/vendor-a/.test(r.message) && /vendor-b/.test(r.message),
      'both candidates must be named');
  });

  it('names the available actions when the action is missing', () => {
    const r = addr.resolveAddress(spec, addr.parseAddress('repo-scan/scanService.nope'));
    assert.strictEqual(r.ok, false);
    assert.ok(/peek/.test(r.message), 'message should list what does exist');
  });

  it('reports a device with no serviceList instead of throwing', () => {
    const r = addr.resolveAddress({device: {friendlyName: 'x'}}, addr.parseAddress('x/y.z'));
    assert.strictEqual(r.ok, false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx mocha ./test/composition/01-call-address.js
```

Expected: FAIL — `Cannot find module '../../lib/call-address'`.

- [ ] **Step 3: Write the implementation**

Create `lib/call-address.js`:

```js
// A composition address: <friendlyName>/<serviceLabel>.<actionName>
//
//   repo-scan/scanService.scan
//
// Deliberately NOT the MCP tool name (repo_scan_scan). Tool names are
// deduped with a _2 suffix on collision, in an order that depends on module
// load order (lib/mcp/tool-registry.js), slugify is lossy, and actions
// without a description are dropped from tools/list entirely -- none of
// which a hardcoded address can survive.
//
// This file has no requires beyond uuid-1345 so the serverless validator and
// its tests can load it without opening a Redis socket, the same reason
// lib/mcp/tool-name.js exists alone.
const UUID = require('uuid-1345');

const ADDRESS_FORM = '<module>/<service>.<action>';

// 'apemesh' in the seed is a deliberately kept hash seed, not a missed
// rename: changing it reassigns every existing device's UUID. This is the
// single definition -- lib/countinghouse-device.js calls it rather than
// repeating the template, because a drifted copy would make every address
// resolve to a device that does not exist.
function deviceIDForName(friendlyName) {
  return UUID.v5({
    namespace: UUID.namespace.url,
    name: `https://registry.apemesh.com/packages/${friendlyName}`
  });
}

// Exactly one '/' and one '.', and no part may contain either. Returns null
// rather than guessing: an address with two dots has no correct reading, and
// picking one would resolve silently to the wrong tool.
function parseAddress(address) {
  if (typeof address !== 'string') return null;

  const slash = address.split('/');
  if (slash.length !== 2) return null;

  const device = slash[0];
  const dot    = slash[1].split('.');
  if (dot.length !== 2) return null;

  const service = dot[0];
  const action  = dot[1];

  if (device === '' || service === '' || action === '') return null;
  if (device.indexOf('.') !== -1) return null;

  return {device: device, service: service, action: action};
}

// The service half cannot be resolved by string rules: the URN's vendor
// segment varies across modules (urn:countinghouse-com:, urn:example-com:),
// so the target's own spec is the only authority.
function resolveAddress(spec, parsed) {
  if (parsed == null) {
    return {ok: false, message: `not a valid address -- expected ${ADDRESS_FORM}`};
  }

  const serviceList = (spec != null && spec.device != null) ? spec.device.serviceList : null;
  if (serviceList == null) {
    return {ok: false, message: `module "${parsed.device}" declares no services`};
  }

  const matches = [];
  const known   = [];
  for (const urn in serviceList) {
    const label = urn.split(':').pop();
    known.push(label);
    if (label === parsed.service) matches.push(urn);
  }

  if (matches.length === 0) {
    return {ok: false, message: `module "${parsed.device}" has no service "${parsed.service
                                }" -- it declares: ${known.join(', ')}`};
  }
  if (matches.length > 1) {
    return {ok: false, message: `service label "${parsed.service}" is ambiguous on module "${
                                parsed.device}" -- it matches ${matches.join(' and ')
                                }. Rename one of them.`};
  }

  const serviceID  = matches[0];
  const actionList = serviceList[serviceID].actionList;
  const actions    = Array.isArray(actionList) ? actionList.map((a) => a.name) : [];

  if (actions.indexOf(parsed.action) === -1) {
    return {ok: false, message: `service "${parsed.service}" on module "${parsed.device
                                }" has no action "${parsed.action}" -- it declares: ${
                                actions.join(', ')}`};
  }

  return {ok: true, serviceID: serviceID};
}

module.exports = {
  ADDRESS_FORM:    ADDRESS_FORM,
  deviceIDForName: deviceIDForName,
  parseAddress:    parseAddress,
  resolveAddress:  resolveAddress
};
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx mocha ./test/composition/01-call-address.js
```

Expected: PASS, 12 passing.

- [ ] **Step 5: Move the derivation out of `countinghouse-device.js`**

In `lib/countinghouse-device.js`, add to the requires:

```js
const callAddress = require('./call-address');
```

Replace lines 29–35 (the comment and `this.deviceID = UUID.v5({...})`) with:

```js
  // Derived from friendlyName, in lib/call-address.js -- the single
  // definition, so a composition address and a device's real ID cannot
  // disagree. The 'apemesh' hash seed lives there and is deliberately kept;
  // changing it would reassign every existing device's UUID.
  // See MIGRATION.md's "Not changed" section.
  this.deviceID = callAddress.deviceIDForName(spec.device.friendlyName);
```

Leave the `UUID` require in place only if another line still uses it — check with `grep -n 'UUID' lib/countinghouse-device.js` and remove the require if nothing does, so lint stays clean.

- [ ] **Step 6: Prove no device's ID moved**

```bash
npm run lint
npm run golden
npx mocha ./test/composition/01-call-address.js
npx mocha ./test/test1.js && npx mocha ./test/test2.js && npx mocha ./test/test3.js && \
npx mocha ./test/test4.js && npx mocha --exit ./test/test5.js && npx mocha ./test/test6.js
npx mocha ./test/auth/*.js ./test/module-loading/*.js ./test/mcp-contract/*.js
```

Expected: all pass. The golden file contains real tool names built from real deviceIDs — if the derivation moved, it changes. It must not.

- [ ] **Step 7: Commit**

```bash
git add lib/call-address.js lib/countinghouse-device.js test/composition/01-call-address.js
git commit -m "feat(composition): call-address, the one definition of a tool address

Parses <module>/<service>.<action> and derives the device UUID. CHDevice
now calls this instead of repeating the seed template -- two copies could
drift, and every address would then resolve to a device that does not
exist. A test pins both to the same UUID."
```

---

### Task 3: `identityForModule` across the auth providers

**Files:**
- Modify: `lib/auth/provider.js`, `lib/auth/file-provider.js`, `lib/auth/sqlite-provider.js`
- Create: `test/composition/05-module-identity.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AuthProvider.prototype.identityForModule(friendlyName, callback)`, `callback(err, result)` where `result` is `{apiKey: string|null, conflicts: [apiKey, ...]|null}`. `apiKey` is the identity bound to that module; `conflicts` lists every claimant when more than one binds it, and `apiKey` is then `null`.

- [ ] **Step 1: Write the failing test**

Create `test/composition/05-module-identity.js`:

```js
// identityForModule on both shipped auth backends. No server, no ports.
//
// The sqlite half probes the native binding IN A CHILD PROCESS and skips on
// failure. A sqlite3 built against the wrong Node ABI does not throw -- it
// SIGSEGVs during module registration and takes the whole mocha run down
// with zero output, which looks like a broken suite rather than one bad
// addon. Same technique and reasoning as test/auth/03-sqlite-provider-unit.js.
const assert    = require('assert');
const fs        = require('fs');
const os        = require('os');
const path      = require('path');
const spawnSync = require('child_process').spawnSync;

require('../../lib/cli-options').setOptions({});
const FileAuthProvider = require('../../lib/auth/file-provider');

function tmpAuthFile(config) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ident-')), 'auth.json');
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

describe('file provider: identityForModule', () => {
  it('returns the identity that lists the module', (done) => {
    const p = tmpAuthFile({
      'demo-key': {userName: 'demo', devices: ['*']},
      'repo-review-internal': {userName: 'ri', devices: ['d1'], runsModules: ['repo-review']}
    });
    new FileAuthProvider({configPath: p}).identityForModule('repo-review', (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.apiKey, 'repo-review-internal');
      assert.strictEqual(result.conflicts, null);
      done();
    });
  });

  it('returns null for a module nothing binds', (done) => {
    const p = tmpAuthFile({'demo-key': {userName: 'demo', devices: ['*']}});
    new FileAuthProvider({configPath: p}).identityForModule('repo-review', (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.apiKey, null);
      assert.strictEqual(result.conflicts, null);
      done();
    });
  });

  it('reports every claimant when two identities bind the same module', (done) => {
    const p = tmpAuthFile({
      'one': {userName: 'one', devices: [], runsModules: ['repo-review']},
      'two': {userName: 'two', devices: [], runsModules: ['repo-review']}
    });
    new FileAuthProvider({configPath: p}).identityForModule('repo-review', (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.apiKey, null, 'must not pick one silently');
      assert.deepStrictEqual(result.conflicts.sort(), ['one', 'two']);
      done();
    });
  });

  it('ignores a runsModules that is not an array', (done) => {
    const p = tmpAuthFile({'one': {userName: 'one', devices: [], runsModules: 'repo-review'}});
    new FileAuthProvider({configPath: p}).identityForModule('repo-review', (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.apiKey, null);
      done();
    });
  });
});

function probeSqlite3() {
  const probe = spawnSync(process.execPath, ['-e', 'require("sqlite3")'], {encoding: 'utf8'});
  if (probe.status === 0) return null;
  if (probe.signal != null) return `native binding crashed the probe with ${probe.signal}`;
  return (probe.stderr || '').split('\n')[0];
}

describe('sqlite provider: identityForModule', function() {
  const skipReason = probeSqlite3();
  let provider;

  before(function() {
    if (skipReason != null) return this.skip();
    const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ident-db-')), 'auth.sqlite3');
    provider = new SqliteAuthProvider({dbPath: dbPath});
  });

  it('returns the identity bound to the module', (done) => {
    provider.db.run('INSERT INTO module_identities (moduleName, apiKey) VALUES (?, ?)',
      ['repo-review', 'repo-review-internal'], (err) => {
        assert.ifError(err);
        provider.identityForModule('repo-review', (err2, result) => {
          assert.ifError(err2);
          assert.strictEqual(result.apiKey, 'repo-review-internal');
          assert.strictEqual(result.conflicts, null);
          done();
        });
      });
  });

  it('returns null for a module nothing binds', (done) => {
    provider.identityForModule('not-bound', (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.apiKey, null);
      done();
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx mocha ./test/composition/05-module-identity.js
```

Expected: FAIL — `provider.identityForModule is not a function`.

- [ ] **Step 3: Declare it on the interface**

Append to `lib/auth/provider.js`, before `module.exports`:

```js
// Which identity a module runs as when it composes -- the `as` in
// ctx.serviceClient, and what ctx.call uses without the module naming it.
//
// This is deliberately auth-provider state rather than something a module
// declares about itself: which identity a module runs as is the operator's
// decision, and baking it into the module would mean the same module could
// not be deployed twice under different identities.
//
// callback(err, result): result is {apiKey, conflicts}. `apiKey` is the bound
// identity, or null when nothing binds this module. `conflicts` is null
// normally, or the list of every claimant when more than one identity binds
// the same module -- in which case `apiKey` is null, because silently picking
// one would make authorization and billing depend on iteration order.
AuthProvider.prototype.identityForModule = function(friendlyName, callback) {
  throw new Error('AuthProvider.identityForModule must be implemented by a subclass');
};
```

- [ ] **Step 4: Implement it on the file provider**

In `lib/auth/file-provider.js`, add before `module.exports`:

```js
// Scans entries rather than keeping an index: auth.json is loaded once at
// construction and is small, and an index would be a second thing to keep
// correct. COUNTINGHOUSE_API_KEY is deliberately not consulted -- it is a
// wildcard *caller* bypass, and making it an implicit composition identity
// for every module would grant inner hops nobody configured.
FileAuthProvider.prototype.identityForModule = function(friendlyName, callback) {
  const claimants = [];

  for (const apiKey in this.config) {
    const entry = this.config[apiKey];
    if (entry == null || !Array.isArray(entry.runsModules)) continue;
    if (entry.runsModules.indexOf(friendlyName) !== -1) claimants.push(apiKey);
  }

  if (claimants.length === 0) return callback(null, {apiKey: null, conflicts: null});
  if (claimants.length > 1)   return callback(null, {apiKey: null, conflicts: claimants});

  return callback(null, {apiKey: claimants[0], conflicts: null});
};
```

Also update the file's header comment block, which documents the shape, to include the new field:

```js
//   {
//     "<apiKey>": {"userName": "...", "devices": ["<deviceID>", ...], "admin": true,
//                  "runsModules": ["<friendlyName>", ...]}
//   }
//
// `runsModules` is optional and names the modules that run AS this identity
// when they compose (see AuthProvider.identityForModule). Absent on every
// pre-existing entry, which is why nothing needs migrating.
```

- [ ] **Step 5: Implement it on the sqlite provider**

In `lib/auth/sqlite-provider.js`, add one statement inside `_ensureSchema`'s `db.serialize()`, after the `user_devices` line:

```js
    db.run('CREATE TABLE IF NOT EXISTS module_identities (moduleName TEXT PRIMARY KEY, apiKey TEXT NOT NULL)');
```

Add before `module.exports`:

```js
// moduleName is the PRIMARY KEY, so the two-claimants case the file provider
// has to detect by scanning cannot arise here -- the insert fails instead.
// `conflicts` is still part of the returned shape so both providers answer
// identically.
SqliteAuthProvider.prototype.identityForModule = function(friendlyName, callback) {
  if (friendlyName == null) return callback(null, {apiKey: null, conflicts: null});

  this.db.get('SELECT apiKey FROM module_identities WHERE moduleName = ?', [friendlyName], (err, row) => {
    if (err) return callback(err);
    if (row == null) return callback(null, {apiKey: null, conflicts: null});
    return callback(null, {apiKey: row.apiKey, conflicts: null});
  });
};
```

- [ ] **Step 6: Run the tests**

```bash
npx mocha ./test/composition/05-module-identity.js
npx mocha ./test/auth/*.js
npm run lint
```

Expected: the composition file passes (sqlite half may skip with a reason printed — that is correct behaviour, not a failure); the whole auth suite still passes.

- [ ] **Step 7: Commit**

```bash
git add lib/auth/ test/composition/05-module-identity.js
git commit -m "feat(composition): identityForModule on both auth backends

Which identity a module composes as is the operator's decision, so it is
declared in auth config (runsModules on the identity's own entry, or a
module_identities row) rather than inside the module. Two identities
claiming one module is refused, not resolved by iteration order."
```

---

### Task 4: `ctx.call`

**Files:**
- Modify: `lib/countinghouse-util.js` (add `queryDeviceSpec`), `lib/handler-ctx.js`
- Create: `test/fixtures/compose-callee/`, `test/fixtures/compose-caller/`
- Create: `test/composition/02-ctx-call.js`

**Interfaces:**
- Consumes: `callAddress.parseAddress`, `callAddress.deviceIDForName`, `callAddress.resolveAddress` (Task 2).
- Produces:
  - `CHUtil.queryDeviceSpec(deviceID, callback)` → `callback(err, spec)`.
  - `ctx.call(address, input)` → Promise resolving `data`; `ctx.call(address, input, {detail: true})` → Promise resolving `{data, platformMetering}`.
  - `handlerCtx.setComposition(device, {identity, allowed})` — internal, called by Task 5's load-time verification to hand a device its resolved identity and the set of addresses it declared. Stores them as `device._composition`. `allowed` is an object used as a set: `{'<address>': true}`.

- [ ] **Step 1: Add the spec-only device query**

`ctx.call` needs the target's spec before it can build a client, and `createServiceClient` needs a concrete `serviceID` to build one — so the spec has to be fetched first. In `lib/countinghouse-util.js`, add a method alongside `createServiceClient`:

```js
  // The spec of another loaded device, by deviceID. createServiceClient
  // already reaches it, but only as a step toward a client for a serviceID
  // the caller must already know -- ctx.call resolves the serviceID FROM the
  // spec, so it needs this half on its own.
  //
  // The three branches mirror createServiceClient's exactly, deliberately: in
  // worker mode the child asks the parent (queryDeviceForChild queues the
  // reply while discovery is still running, which is what lets a composing
  // module name a target that loads after it), and calling from the main
  // thread in worker mode is a programming error, not a runtime condition.
  queryDeviceSpec: function(deviceID, callback) {
    if (typeof(callback) !== 'function') return;
    if (deviceID == null || typeof(deviceID) !== 'string') {
      return callback(new Error('must specify deviceID'), null);
    }
    if (options.debug === true && options.verifyModule === true) {
      return callback(new Error('ctx.call needs a local runtime -- it is not available ' +
                                'under --debug --verifyModule, which resolves devices ' +
                                'through the remote portal'), null);
    }

    const relay = (err, deviceOrSpec) => {
      if (err != null) return callback(new Error(err.message), null);
      // main thread hands back a CHDevice, a worker hands back the spec itself
      const spec = (deviceOrSpec != null && deviceOrSpec.spec != null) ? deviceOrSpec.spec : deviceOrSpec;
      if (spec == null || spec.device == null) {
        return callback(new CHError('NO_VALID_DEVICE_SPEC', deviceID), null);
      }
      return callback(null, spec);
    };

    if (options.workerThread !== true && isMainThread === true) {
      return this.dm.emit('querydevice', deviceID, relay);
    }
    if (options.workerThread !== true && isMainThread === false) {
      const wm = this.dm.workerMessage;
      if (wm == null) return callback(new CHError('QUERY_DEVICE_ON_MAIN_THREAD'), null);
      return wm.sendDeviceQueryMessageToParent(deviceID, relay);
    }
    return callback(new CHError('QUERY_DEVICE_ON_MAIN_THREAD'), null);
  },
```

Check the top of `lib/countinghouse-util.js` for how `isMainThread` and `options` are already in scope (`createServiceClient` uses both) and reuse them rather than re-requiring.

- [ ] **Step 2: Write the failing test and its fixtures**

Create `test/fixtures/compose-callee/package.json`:

```json
{
  "name": "compose-callee",
  "version": "1.0.0",
  "main": "index.js",
  "license": "Apache-2.0"
}
```

Create `test/fixtures/compose-callee/api.json`:

```json
{
  "device": {
    "friendlyName": "compose-callee",
    "manufacturer": "countinghouse",
    "modelDescription": "Callee half of the ctx.call fixture chain.",
    "serviceList": {
      "urn:countinghouse-test:serviceID:calleeService": {
        "actionList": [
          {
            "name": "double",
            "description": "Doubles a number. Exists so a composing fixture has something to call.",
            "input":  {"schema": "/calleeService/double/input"},
            "output": {"schema": "/calleeService/double/output"}
          },
          {
            "name": "boom",
            "description": "Always fails. Exists so the failure path has something to fail on.",
            "input":  {"schema": "/calleeService/boom/input"},
            "output": {"schema": "/calleeService/boom/output"}
          }
        ]
      }
    }
  }
}
```

Create `test/fixtures/compose-callee/schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/",
  "type": "object",
  "calleeService": {
    "double": {
      "input":  {"type": "object", "properties": {"n": {"type": "number"}}, "required": ["n"]},
      "output": {"type": "object", "properties": {"n": {"type": "number"}}, "required": ["n"]}
    },
    "boom": {
      "input":  {"type": "object", "properties": {}},
      "output": {"type": "object", "properties": {"never": {"type": "string"}}}
    }
  }
}
```

Create `test/fixtures/compose-callee/handlers/calleeService/double.js`:

```js
module.exports = async (input) => ({n: input.n * 2});
```

Create `test/fixtures/compose-callee/handlers/calleeService/boom.js`:

```js
module.exports = async () => { throw new Error('boom from the callee'); };
```

Create `test/fixtures/compose-caller/package.json` — note the declaration:

```json
{
  "name": "compose-caller",
  "version": "1.0.0",
  "main": "index.js",
  "license": "Apache-2.0",
  "countinghouse": {
    "calls": [
      "compose-callee/calleeService.double",
      "compose-callee/calleeService.boom"
    ]
  }
}
```

Create `test/fixtures/compose-caller/api.json` with `friendlyName` `compose-caller`, one service `urn:countinghouse-test:serviceID:callerService`, and three actions, each with a `description`: `viaCall` (input `{n}`, output `{n}`), `undeclared` (input `{}`, output `{n}`), `viaBoom` (input `{}`, output `{n}`). Mirror the callee's `api.json` and `schema.json` structure exactly — every action needs a `description` or it is dropped from `tools/list`.

Create `test/fixtures/compose-caller/handlers/callerService/viaCall.js`:

```js
module.exports = async (input, ctx) => {
  const data = await ctx.call('compose-callee/calleeService.double', {n: input.n});
  return {n: data.n};
};
```

Create `test/fixtures/compose-caller/handlers/callerService/undeclared.js`:

```js
// Calls an address this module did not declare. The point is that the
// declaration is enforced -- ctx.call must refuse this before it ever tries
// to resolve the target.
module.exports = async (input, ctx) => {
  const data = await ctx.call('compose-callee/calleeService.triple', {});
  return {n: 0, data: data};
};
```

Create `test/fixtures/compose-caller/handlers/callerService/viaBoom.js`:

```js
module.exports = async (input, ctx) => {
  const data = await ctx.call('compose-callee/calleeService.boom', {});
  return {n: 0, data: data};
};
```

The three handlers divide the cases cleanly: `viaCall` and `viaBoom` call declared addresses (the success and failure paths), while `undeclared` calls `compose-callee/calleeService.triple` — an address no `calls` entry lists — so Task 5 has an enforcement case to assert against.

Create `test/composition/02-ctx-call.js`:

```js
// A real two-hop call through ctx.call, in worker-thread mode, on port 9556.
const assert  = require('assert');
const path    = require('path');
const request = require('supertest');
const spawn   = require('child_process').spawn;

const PORT = 9556;
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const BASE = `http://127.0.0.1:${PORT}`;

let server;

function startServer(done) {
  server = spawn(process.execPath, [
    path.join(__dirname, '..', '..', 'framework.js'),
    '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(PORT),
    '--authConfigPath', path.join(__dirname, 'fixtures-auth.json'),
    '--loadModule', path.join(FIXTURES, 'compose-callee'),
    '--loadModule', path.join(FIXTURES, 'compose-caller')
  ], {stdio: ['ignore', 'pipe', 'pipe']});

  let out = '';
  const onData = (buf) => {
    out += buf.toString();
    if (/device list ready|server listening|new device online/i.test(out)) {
      // give discovery a beat to finish registering the second module
      setTimeout(done, 1500);
      server.stdout.removeListener('data', onData);
    }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
}

describe('ctx.call: a real two-hop call', function() {
  this.timeout(40000);

  before(function(done) { startServer(done); });
  after(function() { if (server != null) server.kill('SIGKILL'); });

  it('calls the callee and returns its data', (done) => {
    request(BASE)
      .post('/mcp')
      .set('X-CH-Key', 'composition-test-key')
      .set('Accept', 'application/json, text/event-stream')
      .send({jsonrpc: '2.0', id: 1, method: 'tools/call',
             params: {name: 'compose_caller_callerservice_viacall', arguments: {n: 21}}})
      .expect(200)
      .end((err, res) => {
        assert.ifError(err);
        const body = JSON.parse(res.text.replace(/^data: /m, '').trim().split('\n').pop());
        assert.strictEqual(body.result.isError, undefined);
        const payload = JSON.parse(body.result.content[0].text);
        assert.strictEqual(payload.n, 42, 'ctx.call should have doubled 21');
        done();
      });
  });
});
```

Create `test/composition/fixtures-auth.json`:

```json
{
  "composition-test-key": {
    "userName": "composition-test",
    "devices": ["*"]
  },
  "compose-caller-internal": {
    "userName": "compose-caller-internal",
    "devices": ["*"],
    "runsModules": ["compose-caller"]
  }
}
```

Before writing the assertions above, run the server by hand once and record the real tool name and MCP response envelope:

```bash
node framework.js --workerThread --bindAddr 127.0.0.1 --port 9556 \
  --authConfigPath test/composition/fixtures-auth.json \
  --loadModule test/fixtures/compose-callee --loadModule test/fixtures/compose-caller &
curl -s -X POST http://127.0.0.1:9556/mcp -H 'X-CH-Key: composition-test-key' \
  -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Copy the exact tool name and reply shape into the test rather than trusting the guesses above; then kill the server with its explicit PID (never `pkill -f framework.js` — the pattern matches the shell running it).

- [ ] **Step 3: Run it and confirm it fails**

```bash
npx mocha ./test/composition/02-ctx-call.js
```

Expected: FAIL — the tool call returns an error because `ctx.call` is not a function.

- [ ] **Step 4: Implement `ctx.call`**

In `lib/handler-ctx.js`, add near the top:

```js
const callAddress = require('./call-address');
const CHUtil      = require('./countinghouse-util');
```

Check for a require cycle first: `countinghouse-util.js` pulls in `countinghouse-device.js`, which is why `lib/session.js` requires it lazily inside the function. Do the same here — require it inside `call` rather than at file top if `node -e "require('./lib/handler-ctx')"` warns or returns a half-initialised object.

Add to the object `ctx` is built from, after `serviceClient`:

```js
    // Composition by name. The identity and the allowed set come from
    // load-time verification (see DeviceManager), not from the handler --
    // a module never names the identity it runs as.
    call: (address, input, opts) => {
      const detail = (opts != null && opts.detail === true);
      const comp   = (device != null) ? device._composition : null;

      return new Promise((resolve, reject) => {
        if (comp == null || comp.identity == null) {
          return reject(new Error(`ctx.call is unavailable: no auth identity is bound to this ` +
                                  `module. Add its friendlyName to some identity's "runsModules" ` +
                                  `in your auth config.`));
        }
        if (comp.allowed[address] !== true) {
          return reject(new Error(`ctx.call: "${address}" is not declared by this module. ` +
                                  `Add it to "countinghouse.calls" in package.json.`));
        }

        const parsed = callAddress.parseAddress(address);
        if (parsed == null) {
          return reject(new Error(`ctx.call: "${address}" is not a valid address -- expected ${
                                  callAddress.ADDRESS_FORM}`));
        }

        const deviceID = callAddress.deviceIDForName(parsed.device);

        return CHUtil.queryDeviceSpec(deviceID, (specErr, spec) => {
          if (specErr != null) return reject(specErr);

          const resolved = callAddress.resolveAddress(spec, parsed);
          if (resolved.ok !== true) return reject(new Error(`ctx.call: ${resolved.message}`));

          return ctx.serviceClient({deviceID: deviceID, serviceID: resolved.serviceID,
                                    as: comp.identity}, (clientErr, client) => {
            if (clientErr != null) return reject(clientErr);

            return client.invoke({actionName: parsed.action, input: input},
              (err, data, platformMetering) => {
                if (err != null) {
                  // The callee's structured fault, when the path supplied one.
                  // Never invented, and never merged into `data`.
                  err.fault = (data != null) ? data : null;
                  return reject(err);
                }
                return resolve(detail ? {data: data, platformMetering: platformMetering} : data);
              });
          });
        });
      });
    },
```

`ctx` must be referenced by name inside `call`, so make sure `call` is defined on an object the surrounding function already holds a reference to (`const ctx = {...}; return ctx;`). If the file currently returns an object literal directly, bind it to a `const ctx` first.

Add the internal setter used by Task 5, next to the `ctx` construction:

```js
// Set once at load by DeviceManager's composition verification. Kept on the
// device rather than on ctx because ctx is rebuilt per call.
function setComposition(device, composition) {
  if (device != null) device._composition = composition;
}
```

and export it alongside whatever `handler-ctx.js` already exports.

- [ ] **Step 5: Run and confirm it passes**

```bash
npx mocha ./test/composition/02-ctx-call.js
```

Expected: PASS. If it fails with "no auth identity is bound", Task 5 is not written yet — for this task only, temporarily set `device._composition` from the fixture's own `main` to prove the call path, then delete that scaffolding in Task 5. Note it in the commit message if you do.

- [ ] **Step 6: Full suite and lint**

```bash
npm run lint && npm run golden
npx mocha ./test/test1.js && npx mocha ./test/test2.js && npx mocha ./test/test3.js && \
npx mocha ./test/test4.js && npx mocha --exit ./test/test5.js && npx mocha ./test/test6.js
npx mocha ./test/auth/*.js
```

Confirm `test/auth/13-ctx-billing-identity.js` passes untouched — it is the proof `ctx.serviceClient` still behaves exactly as before.

- [ ] **Step 7: Commit**

```bash
git add lib/handler-ctx.js lib/countinghouse-util.js test/fixtures/compose-caller test/fixtures/compose-callee test/composition/
git commit -m "feat(composition): ctx.call, composition by name

await ctx.call('compose-callee/calleeService.double', {n: 21}) instead of
a pasted UUID, a service URN, an identity string and two promise wrappers.
Resolves the service URN from the target's own spec, because the URN's
vendor segment varies per module. Promise-shaped on purpose: lib/service.js
settles a returned promise on both outcomes, while the callback path is the
one where a cross-worker exception can be swallowed until the 30s timeout."
```

---

### Task 5: Load-time verification

**Files:**
- Modify: `lib/device-manager.js`
- Create: `test/composition/03-declaration.js`

**Interfaces:**
- Consumes: `callAddress.*` (Task 2), `authProvider.identityForModule` (Task 3), `handlerCtx.setComposition` (Task 4).
- Produces: `DeviceManager.prototype.verifyComposition(deviceID, spec, packageInfo, modulePath, callback)` → `callback(err, composition)`. `err` non-null means the module must not come online. On success `composition` is `{identity, allowed}`, exactly the shape `handlerCtx.setComposition` expects; it is `undefined` when the module declares no `calls`, which is not an error.

- [ ] **Step 1: Write the failing test**

Create `test/composition/03-declaration.js` on port 9557, with three cases:

1. A module declaring an address for an action that does not exist fails at load — assert the server's stderr names both the module and the address, and that its tool is absent from `tools/list`.
2. Calling an address the module did not declare is refused at call time — invoke `compose_caller_callerservice_undeclared` and assert the result is an error whose message contains `countinghouse.calls`.
3. A module declaring `calls` with no identity bound in auth config fails at load — assert stderr mentions `runsModules`.

Use the same `startServer` helper shape as `02-ctx-call.js`, but capture stderr into a string the assertions read, and give each case its own fixture directory (`compose-caller-badaddr`, `compose-caller-noident`) so one failure does not mask another. Copy `compose-caller` and change only `countinghouse.calls` and the auth file.

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx mocha ./test/composition/03-declaration.js
```

Expected: FAIL — modules with bad declarations currently load fine.

- [ ] **Step 3: Implement `verifyComposition`**

In `lib/device-manager.js`:

```js
// Every declared address is resolved once, at load, after discovery has
// finished. A typo becomes a startup error naming the module and the address,
// instead of a runtime failure the first time that code path is reached.
//
// Runs after allDevicesLoaded: resolution goes through the same querydevice
// path that queues while discovery is in flight, so a composing module may
// declare a target that loads after it.
DeviceManager.prototype.verifyComposition = function(deviceID, spec, packageInfo, modulePath, callback) {
  const declared = (packageInfo != null && packageInfo.countinghouse != null &&
                    Array.isArray(packageInfo.countinghouse.calls))
    ? packageInfo.countinghouse.calls : null;

  if (declared == null || declared.length === 0) return callback(null);

  const friendlyName = spec.device.friendlyName;
  const moduleName   = (packageInfo != null && packageInfo.name != null) ? packageInfo.name : friendlyName;

  if (moduleName !== friendlyName) {
    return callback(new CHError('MODULE_COMPOSITION_INVALID', moduleName,
      `package.json name "${moduleName}" and api.json friendlyName "${friendlyName
      }" disagree. Composition binds by friendlyName, so they must match.`));
  }

  this.authProvider.identityForModule(friendlyName, (identErr, identity) => {
    if (identErr != null) return callback(identErr);

    if (identity.conflicts != null) {
      return callback(new CHError('MODULE_COMPOSITION_INVALID', friendlyName,
        `more than one auth identity claims this module in "runsModules": ${
        identity.conflicts.join(', ')}. Exactly one must.`));
    }
    if (identity.apiKey == null) {
      return callback(new CHError('MODULE_COMPOSITION_INVALID', friendlyName,
        `it declares ${declared.length} composition target(s) in package.json's ` +
        '"countinghouse.calls", but no auth identity lists it in "runsModules". ' +
        'Add it to the identity you want its inner hops authorized as.'));
    }

    const allowed = {};
    let pending   = declared.length;
    let failed    = false;

    const finish = (err) => {
      if (failed === true) return;
      if (err != null) { failed = true; return callback(err); }
      pending--;
      if (pending === 0) return callback(null, {identity: identity.apiKey, allowed: allowed});
    };

    declared.forEach((address) => {
      const parsed = callAddress.parseAddress(address);
      if (parsed == null) {
        return finish(new CHError('MODULE_COMPOSITION_INVALID', friendlyName,
          `"${address}" in package.json's "countinghouse.calls" is not a valid address ` +
          `-- expected ${callAddress.ADDRESS_FORM}`));
      }

      const targetID = callAddress.deviceIDForName(parsed.device);

      this.emit('querydevice', targetID, (qErr, deviceOrSpec) => {
        if (qErr != null) {
          return finish(new CHError('MODULE_COMPOSITION_INVALID', friendlyName,
            `declares "${address}", but module "${parsed.device}" is not loaded`));
        }
        const targetSpec = (deviceOrSpec != null && deviceOrSpec.spec != null) ? deviceOrSpec.spec : deviceOrSpec;
        const resolved   = callAddress.resolveAddress(targetSpec, parsed);
        if (resolved.ok !== true) {
          return finish(new CHError('MODULE_COMPOSITION_INVALID', friendlyName,
            `declares "${address}": ${resolved.message}`));
        }

        this.authProvider.authenticate(identity.apiKey, targetID, resolved.serviceID, parsed.action,
          (authErr, result) => {
            if (authErr != null) return finish(authErr);
            if (result.ok !== true) {
              return finish(new CHError('MODULE_COMPOSITION_INVALID', friendlyName,
                `identity "${identity.apiKey}" has no grant to "${address}". Add device ${
                targetID} to its "devices".`));
            }
            allowed[address] = true;
            return finish(null);
          });
      });
    });
  });
};
```

Add `MODULE_COMPOSITION_INVALID` to both `lib/error-info.en-US.json` and `lib/error-info.zh-CN.json`, following the existing entries' style.

Confirm how `DeviceManager` reaches the auth provider before writing `this.authProvider` — check with `grep -n 'authProvider\|getAuthProvider' lib/device-manager.js lib/user-auth.js lib/auth/index.js` and use whatever accessor already exists rather than adding a field.

- [ ] **Step 4: Call it from the load path**

Call `verifyComposition` once discovery is complete, in `DeviceManager.prototype.onAllModulesDiscovered`, for every registered device — not from `onDeviceOnline`, where targets may not exist yet. On success, hand the result to the device with `handlerCtx.setComposition`; on failure, log the error and purge that device so it does not serve traffic with a broken chain.

Read `onAllModulesDiscovered` first (`grep -n 'onAllModulesDiscovered' lib/device-manager.js`) and follow the iteration style already there.

- [ ] **Step 5: Run and confirm it passes**

```bash
npx mocha ./test/composition/03-declaration.js
npx mocha ./test/composition/02-ctx-call.js
```

Expected: both pass. Remove any temporary `_composition` scaffolding added in Task 4 Step 5.

- [ ] **Step 6: Full suite, lint, golden**

```bash
npm run lint && npm run golden
npx mocha ./test/test1.js && npx mocha ./test/test2.js && npx mocha ./test/test3.js && \
npx mocha ./test/test4.js && npx mocha --exit ./test/test5.js && npx mocha ./test/test6.js
npx mocha ./test/auth/*.js ./test/module-loading/*.js ./test/module-authoring/*.js
```

- [ ] **Step 7: Commit**

```bash
git add lib/device-manager.js lib/error-info.en-US.json lib/error-info.zh-CN.json test/composition/03-declaration.js test/fixtures/
git commit -m "feat(composition): verify declared chains at load, not at first call

Resolves every countinghouse.calls entry after discovery completes, binds
the module's identity from auth config, and checks the identity's grant to
each target. A typo is now a startup error naming the module and the
address rather than a failure the first time that branch runs."
```

---

### Task 6: Failure and billing

**Files:**
- Create: `test/composition/04-failure-and-billing.js`
- Modify: `lib/handler-ctx.js` only if the test proves `.fault` is wrong

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: no new interface. This task pins behaviour.

- [ ] **Step 1: Write the test**

Create `test/composition/04-failure-and-billing.js` on port 9558, with `--mcpToolCallCost 1`. Assert:

1. Calling `compose_caller_callerservice_viaboom` returns an error to the MCP caller (not a hang, not a 30s timeout). Give the test a 20s timeout so a hang fails loudly rather than passing slowly.
2. The failed hop is **not** billed and the failed outer call is **not** billed: read the caller key's balance before and after, and assert the delta is 0.
3. A successful `viaCall` bills exactly 2 — one hop plus the outer call. Confirm the expected number against `docs/composite-tools.md` before asserting; if it disagrees, the doc is the authority and the test follows it.
4. `.fault` is whatever the path actually delivers. Write the assertion **after** observing it: log the rejected error's `.fault` on both flag states and assert what is really there. If a path delivers nothing, assert `.fault === null` — `ctx.call` must not invent fault content.

Read balances with the settle-then-assert pattern from `test/direct-peer-channels/06-no-double-billing.js` — copy its `settledBalance` helper. The outer charge is fire-and-forget (`lib/session.js:128-140`), so a balance read straight out of the invoke response races. Do **not** poll until the expected number appears: that would hide a surplus charge landing just after.

- [ ] **Step 2: Run it in both flag states**

```bash
npx mocha ./test/composition/04-failure-and-billing.js
CH_TEST_DIRECT_PEER=1 npx mocha ./test/composition/04-failure-and-billing.js
```

Run the second with the server started under `--directPeerChannels`. `docs/direct-peer-channels-design.md` section 3 claims the two paths are externally identical; this test is where that claim gets checked rather than trusted.

- [ ] **Step 3: Fix only what the test disproves**

If `.fault` differs between the two paths, make `ctx.call` normalise to `null` on the path that supplies nothing, and record the difference in `docs/composite-tools.md`. Do not add a field to the reply `data` to carry a fault across — see this plan's Global Constraints.

- [ ] **Step 4: Commit**

```bash
git add test/composition/04-failure-and-billing.js lib/handler-ctx.js docs/composite-tools.md
git commit -m "test(composition): pin ctx.call's failure and billing behaviour

A failed hop is not billed and a failed outer call is not billed; a
rejected ctx.call surfaces as an error rather than hanging to the request
timeout. Runs on both cross-worker paths, because their claimed
equivalence is exactly what needed checking."
```

---

### Task 7: Convert `repo-review`

**Files:**
- Modify: `examples/repo-review/repo-review/package.json`, `examples/repo-review/repo-review/handlers/reviewService/review.js`, `examples/repo-review/auth.json`

**Interfaces:**
- Consumes: `ctx.call` (Task 4), load-time verification (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Add the declaration**

In `examples/repo-review/repo-review/package.json`:

```json
  "countinghouse": {
    "calls": [
      "repo-scan/scanService.scan",
      "secret-detect/detectService.detect",
      "dep-audit/auditService.audit"
    ]
  }
```

- [ ] **Step 2: Bind the identity**

In `examples/repo-review/auth.json`, add to the `repo-review-internal` entry:

```json
    "runsModules": ["repo-review"]
```

- [ ] **Step 3: Record the current numbers before changing the handler**

```bash
npm run demo:repo-review &
node examples/repo-review/token-comparison.js | tee /tmp/before.txt
```

Kill the server by explicit PID afterwards. `bin/countinghouse` spawns a detached child, so killing a wrapper can leave an orphan holding the port.

- [ ] **Step 4: Convert the handler**

In `examples/repo-review/repo-review/handlers/reviewService/review.js`, delete `SCAN_DEVICE_ID`, `DETECT_DEVICE_ID`, `AUDIT_DEVICE_ID`, `SCAN_SERVICE`, `DETECT_SERVICE`, `AUDIT_SERVICE`, `AS_IDENTITY`, `clientFor` and `rawInvoke`. Replace each hop with:

```js
const {data, platformMetering} = await ctx.call('repo-scan/scanService.scan', scanInput, {detail: true});
```

`{detail: true}` is required here — the module builds its per-hop `bill` array from `platformMetering`. Update the file's header comment: it currently describes `ctx.serviceClient` and the two wrappers, and would otherwise document code that no longer exists.

- [ ] **Step 5: Prove the numbers did not move**

```bash
npm run demo:repo-review &
node examples/repo-review/token-comparison.js | tee /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
node examples/repo-review/verify-identity-passthrough.js
```

Byte counts and the hop bill must be unchanged. If the README's 428× figure moves, stop and report — the conversion changed behaviour it should not have.

- [ ] **Step 6: Commit**

```bash
git add examples/repo-review/
git commit -m "refactor(examples): repo-review composes by name

Three device UUIDs, three service URNs, an identity constant and two
promise wrappers become three ctx.call lines. The chain is declared in
package.json and the identity in auth.json. Byte counts and per-hop bill
verified unchanged."
```

---

### Task 8: Declaration checking in the validators

**Files:**
- Modify: `lib/module-validator.js`, `lib/plan-validator.js`
- Modify: `test/module-authoring/01-module-validator.js` (add cases)
- Create: `test/fixtures/bad-calls-module/`

**Interfaces:**
- Consumes: `callAddress.parseAddress` (Task 2).
- Produces: `module-validator` emits `Problem` entries with `stage: 'countinghouse.calls'`.

- [ ] **Step 1: Write the failing tests**

Add to `test/module-authoring/01-module-validator.js`:

```js
describe('module-validator: countinghouse.calls', () => {
  it('reports a malformed address', (done) => {
    moduleValidator.validateModule(fixture('bad-calls-module'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      const problem = result.problems.find((p) => p.stage === 'countinghouse.calls');
      assert.ok(problem != null, 'a calls problem should be reported');
      assert.ok(/repo-scan\.scan/.test(problem.message));
      done();
    });
  });

  it('accepts a well-formed calls list', (done) => {
    moduleValidator.validateModule(fixture('handler-map-convention'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.problems.some((p) => p.stage === 'countinghouse.calls'), false);
      done();
    });
  });
});
```

Create `test/fixtures/bad-calls-module/` as a copy of `test/fixtures/handler-map-convention/` whose `package.json` adds `"countinghouse": {"calls": ["repo-scan.scan"]}` — one dot, no slash, so it cannot parse.

- [ ] **Step 2: Run and confirm they fail**

```bash
npx mocha ./test/module-authoring/01-module-validator.js
```

Expected: FAIL — no `countinghouse.calls` problem is produced.

- [ ] **Step 3: Implement the check in `module-validator.js`**

Read the file's existing `problem()` helper and stage naming first, then add a syntax-only pass over `packageInfo.countinghouse.calls`: each entry must be a string that `callAddress.parseAddress` accepts; the array must not contain duplicates. It cannot check whether a target exists — no server, nothing loaded — and must not pretend to. Say so in the `fix` text: resolution happens at load.

- [ ] **Step 4: Implement the check in `plan-validator.js`**

`validate_plan` runs on a live server, so it *can* resolve targets. Read the file's existing shape and add: for each declared address in the plan, parse it and report an unparseable one; where the runtime can see loaded devices, report a target that does not exist. Follow the file's existing result shape exactly — do not invent a new one.

- [ ] **Step 5: Run and confirm they pass**

```bash
npx mocha ./test/module-authoring/*.js
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add lib/module-validator.js lib/plan-validator.js test/module-authoring/ test/fixtures/bad-calls-module
git commit -m "feat(composition): check countinghouse.calls in both validators

The CLI validator checks address syntax with no server; validate_plan,
which runs against a live runtime, also checks that the targets exist."
```

---

### Task 9: Documentation and the test script

**Files:**
- Modify: `package.json`, `docs/composite-tools.md`, `docs/module-authoring.md`, `docs/module-development.md`

- [ ] **Step 1: Add the new suite to `npm test`**

In `package.json`'s `test` script, add `./test/composition/*.js` to the same `mocha` invocation that already lists `./test/module-authoring/*.js`.

- [ ] **Step 2: Document `ctx.call` in `docs/module-development.md`**

Add a section covering the address form, `countinghouse.calls`, `runsModules`, both `ctx.call` signatures, and that `ctx.serviceClient` remains supported for the cases `ctx.call` deliberately does not cover — a per-call identity override, or a module needing two identities.

- [ ] **Step 3: Update `docs/composite-tools.md`**

`composite-demo` stays on `ctx.serviceClient` on purpose, so document both: `ctx.call` as the default, `ctx.serviceClient` as the escape hatch, with `composite-demo` and `repo-review` as the live example of each. Add whatever Task 6 established about `.fault` across the two cross-worker paths.

- [ ] **Step 4: Update `docs/module-authoring.md`**

Tell the authoring skill about `countinghouse.calls`: what an address looks like, that it is declared in `package.json` and not `api.json`, and that the identity is the operator's to bind.

- [ ] **Step 5: Run the whole suite once, including the benchmark**

```bash
npm test
```

This is the one place the full suite including `test7.js` is warranted — it is the last commit on the branch.

- [ ] **Step 6: Commit**

```bash
git add package.json docs/
git commit -m "docs: ctx.call, and the composition suite in npm test"
```

---

## Self-Review Notes

Checked against the spec, section by section:

- Address format and its rejection of MCP tool names — Task 2.
- Four-step resolution — Task 2 (steps 1, 2, 4) and Task 4 step 1 (step 3, the spec fetch).
- `countinghouse.calls` in `package.json` — Tasks 4 (fixture), 5 (enforcement), 7 (real module), 8 (validation).
- `runsModules` and `identityForModule` on all three provider files — Task 3.
- Four load-time checks — Task 5.
- Failure semantics and billing — Task 6.
- Backward compatibility — asserted in Tasks 4 and 5 by keeping `test/auth/13-ctx-billing-identity.js` green; `composite-demo` untouched throughout.
- Duplicate-deviceID prerequisite — Task 1, first and separate.
- Known limitations — documented in Task 9, not implemented, as specified.

Two places the plan deliberately tells the implementer to look before writing, rather than guessing:
`DeviceManager`'s auth-provider accessor (Task 5 step 3) and the MCP response envelope plus real tool name (Task 4 step 2). Both are cheap to check and expensive to get wrong.
