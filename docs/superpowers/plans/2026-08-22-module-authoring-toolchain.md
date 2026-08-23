# Module Authoring Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a coding agent author, validate, load and call a countinghouse module for a user, without anyone hand-writing `api.json`/`schema.json` or booting the runtime to find mistakes.

**Architecture:** The agent thinks; countinghouse answers. A standalone validator (`lib/module-validator.js`) turns an existing, already-good set of checks into something callable with no Redis and no server. A CLI and four admin-gated, default-off MCP platform tools wrap it. A skill shipped in-repo carries the decomposition rubric so the agent knows what good looks like.

**Tech Stack:** Node.js >= 20 (CommonJS), mocha + `assert` for tests, express for routes, ajv 8 / JSON Schema 2020-12 for spec validation.

**Spec:** [`../specs/2026-08-22-module-authoring-toolchain-design.md`](../specs/2026-08-22-module-authoring-toolchain-design.md)

## Global Constraints

- Node >= 20; CommonJS (`require`/`module.exports`), matching every file in `lib/`.
- All new code comments and docs in **English**.
- ES6 style per `eslint.config.js` — `const`/`let` (never `var`), template literals, arrow callbacks. `npm run lint` must pass.
- Small commits, one task per commit. Run the relevant tests before each commit.
- The four authoring tools are **admin-gated AND off unless `--authoringTools` is passed**. Default off is a safety property, not a preference.
- Existing validator messages must stay **byte-identical**. This work adds structure around them; it does not reword them.
- Never delete `adaptive-test/`, `perf/`, `spec/`.
- The MCP surface must not move: `npm run golden` must stay green without regenerating `test/mcp-contract/tools-list.golden.json`.
- Test ports: 9550-9552 are reserved for this plan's tests. Do not reuse 9527, 9530-9531, 9541-9546, 9574-9575, 9584-9595 — they are already bound by existing test files, and `npm test` runs several of those suites in the same invocation group.

---

## File Structure

| Path | Responsibility |
|---|---|
| `lib/module-validator.js` | **New.** Directory → `{ok, problems[]}`. The single oracle every other component wraps. No Redis, no worker, no server. |
| `bin/countinghouse-validate` | **New.** CLI over `validateModule`. Exit non-zero on problems. |
| `lib/mcp/tool-name.js` | **New.** `slugify`, extracted so a pure validator can predict tool names without requiring `tool-registry.js` — which opens a Redis socket at require time. |
| `lib/mcp/tool-registry.js` | **Modify.** Add `AUTHORING_TOOLS` / `AUTHORING_TOOL_NAMES` beside the existing `PLATFORM_TOOLS`, and reserve the names so no device tool can take them. |
| `lib/mcp/gateway.js` | **Modify.** List the authoring tools when enabled + admin; dispatch the four in `handleToolsCall`. Gating lives here because this is where caller identity is resolved. |
| `lib/cli-options.js` | **Modify.** `--authoringTools`, default false. |
| `.claude/skills/countinghouse-module/SKILL.md` | **New.** The decomposition rubric and the authoring loop. |
| `test/module-authoring/01-module-validator.js` | **New.** Unit tests for the oracle, against existing fixtures. |
| `test/module-authoring/02-validate-cli.js` | **New.** CLI exit codes and output. |
| `test/module-authoring/03-authoring-tools-gating.js` | **New.** Absent by default; admin-gated when enabled. |
| `test/module-authoring/04-authoring-loop.js` | **New.** End-to-end plan → validate → load → call. |
| `package.json` | **Modify.** Register `countinghouse-validate` in `bin`, add `test/module-authoring/` to the `test` script. |
| `README.md`, `docs/module-development.md` | **Modify.** Document the loop and the validator. |

---

### Task 1: The validator — `lib/module-validator.js`

**Files:**
- Create: `lib/module-validator.js`
- Test: `test/module-authoring/01-module-validator.js`

**Interfaces:**
- Consumes: `lib/handler-map.js`'s `validateHandlerMap(spec, handlerMap, moduleName)` (pure, already exported); `lib/handler-map-module.js`'s `resolveHandlerMap(modulePath, exported, requireFile)` (returns `{handlerMap, source}` or `null`); `lib/validator.js`'s `validateDeviceSpec(spec, callback)` (calls back with an `Error` that may carry `.validationErrors`, an array of `{instancePath, message, schemaPath}`).
- Produces: `validateModule(modulePath, callback)` → `callback(null, {ok: boolean, module: string, problems: Problem[]})` where `Problem` is `{stage: string, module: string, message: string, fix: string|null}`. Never calls back with an error for a *bad module* — a bad module is a successful validation with problems. It calls back with an error only if `modulePath` is unreadable.

**Background the implementer needs:** this approach is already verified to work standalone against the fixtures in `test/fixtures/` — no Redis server is involved, and `handler-map-module.js` requires cleanly. `resolveHandlerMap` returns `null` for legacy discovery-style modules (a class or EventEmitter using `discover`/`deviceonline`); that path is still supported by the runtime, so it is reported as a note-shaped problem, not treated as a crash.

- [ ] **Step 1: Write the failing test**

Create `test/module-authoring/01-module-validator.js`:

```js
// Unit cover for lib/module-validator.js -- the standalone oracle behind
// bin/countinghouse-validate and the countinghouse_validate_module MCP tool.
//
// These run in-process against fixtures that are each broken in exactly one
// way, with no Redis and no server: that independence is the whole point of
// the extraction, so a test file that needed either would be testing the
// wrong thing.
const assert = require('assert');
const path   = require('path');

require('../../lib/cli-options').setOptions({});
const moduleValidator = require('../../lib/module-validator');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const fixture  = (name) => path.join(FIXTURES, name);

describe('module-validator: a well-formed module', () => {
  it('reports ok with no problems', (done) => {
    moduleValidator.validateModule(fixture('handler-map-convention'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.problems, []);
      done();
    });
  });

  it('names the module it validated', (done) => {
    moduleValidator.validateModule(fixture('handler-map-convention'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.module, 'handler-map-convention');
      done();
    });
  });
});

describe('module-validator: handler-map mismatches', () => {
  it('reports a handler service that api.json does not declare', (done) => {
    moduleValidator.validateModule(fixture('handler-map-unknown-service'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      // both directions of the strict check fire for this fixture
      assert.strictEqual(result.problems.length, 2);
      assert.ok(result.problems.every((p) => p.stage === 'assembleHandlerMap'));
      assert.ok(result.problems.some((p) => /declares service "greetingService"/.test(p.message)));
      done();
    });
  });

  it('reports a declared action with no handler', (done) => {
    moduleValidator.validateModule(fixture('handler-map-missing-action'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.problems.length, 1);
      assert.ok(/declares action "greetService.hello"/.test(result.problems[0].message));
      done();
    });
  });

  it('reports a handler for an action api.json does not declare', (done) => {
    moduleValidator.validateModule(fixture('handler-map-undeclared-action'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.problems.length, 1);
      assert.ok(/"greetService.goodbye"/.test(result.problems[0].message));
      done();
    });
  });

  it('collects every problem rather than stopping at the first', (done) => {
    // the point of the extraction: an author who renamed a service wants the
    // whole list, not one problem per re-run
    moduleValidator.validateModule(fixture('handler-map-unknown-service'), (err, result) => {
      assert.ifError(err);
      assert.ok(result.problems.length > 1);
      done();
    });
  });
});

describe('module-validator: spec problems', () => {
  it('reports a spec that fails the meta-schema, with the instance path', (done) => {
    moduleValidator.validateModule(fixture('invalid-spec-module'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      const spec = result.problems.filter((p) => p.stage === 'validateDeviceSpec');
      assert.ok(spec.length > 0, 'expected at least one validateDeviceSpec problem');
      done();
    });
  });

  it('names the migrator for a pre-5.0.0 spec instead of an ajv symptom', (done) => {
    moduleValidator.validateModule(fixture('legacy-spec-module'), (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      assert.ok(result.problems.some((p) => /countinghouse-migrate-spec/.test(p.message)));
      done();
    });
  });
});

describe('module-validator: unusable input', () => {
  it('errors when the directory does not exist', (done) => {
    moduleValidator.validateModule(fixture('no-such-module-anywhere'), (err) => {
      assert.ok(err != null, 'expected an error for a missing directory');
      done();
    });
  });

  it('reports a missing api.json as a problem, not a crash', (done) => {
    moduleValidator.validateModule(FIXTURES, (err, result) => {
      assert.ifError(err);
      assert.strictEqual(result.ok, false);
      assert.ok(result.problems.some((p) => p.stage === 'readApiJson'));
      done();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```sh
export PATH=~/.local/node-v20/bin:$PATH
npx mocha test/module-authoring/01-module-validator.js
```

Expected: every case fails with `Cannot find module '../../lib/module-validator'`.

- [ ] **Step 3: Write the implementation**

Create `lib/module-validator.js`:

```js
// The authoring oracle: a module directory in, a structured problem list out,
// with no Redis, no worker and no running server.
//
// Every check here already existed -- lib/handler-map.js's strict both-way
// check and lib/validator.js's meta-schema validation. What did not exist was
// a way to reach them without booting framework.js, which initialises Redis at
// startup. Authoring is a fix-check-fix loop, for humans and for agents, and a
// loop whose check needs a database is a loop nobody runs.
//
// Messages are passed through byte-identical. This module adds structure
// around them; it deliberately does not reword them, so the text an author
// sees here is the text the server logs.
const fs   = require('fs');
const path = require('path');

const handlerMapLib    = require('./handler-map');
const handlerMapModule = require('./handler-map-module');
const validator        = require('./validator');

function problem(stage, moduleName, message, fix) {
  return {stage: stage, module: moduleName, message: message, fix: fix || null};
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file).toString());
}

// The module's main entry, or null when it has none or it throws. A module in
// the 6.0.0 convention shape (handlers/ directory) legitimately has no main
// entry worth loading, so this failing is not itself a problem -- only a
// handler map that cannot be resolved *at all* is.
function loadExported(modulePath) {
  let pkg = null;
  try {
    pkg = readJSON(path.join(modulePath, 'package.json'));
  } catch (e) {
    return {exported: null, pkgError: e.message};
  }

  const main = pkg.main || 'index.js';
  try {
    return {exported: require(path.join(modulePath, main)), pkgError: null, name: pkg.name};
  } catch (e) {
    return {exported: null, pkgError: null, name: pkg.name, requireError: e.message};
  }
}

// Spec problems are reported one per ajv error so each carries its own
// instancePath -- a single joined string is what made "invalid spec" unhelpful
// in the first place (see lib/device-manager.js's validateDeviceSpec branch).
function specProblems(err, moduleName) {
  if (Array.isArray(err.validationErrors) && err.validationErrors.length > 0) {
    return err.validationErrors.map((e) => {
      return problem('validateDeviceSpec', moduleName,
        `${e.instancePath}: ${e.message}`,
        'Fix the named path in api.json, or its schema.json pointer.');
    });
  }
  return [problem('validateDeviceSpec', moduleName, err.message, null)];
}

function validateModule(modulePath, callback) {
  const resolved = path.resolve(modulePath);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return callback(new Error(`${resolved} is not a directory`));
  }

  const loaded     = loadExported(resolved);
  const moduleName = loaded.name || path.basename(resolved);
  const problems   = [];

  if (loaded.pkgError != null) {
    problems.push(problem('readPackageJson', moduleName,
      `package.json could not be read: ${loaded.pkgError}`,
      'Every module needs a package.json with a name.'));
  }

  let spec = null;
  const apiPath = path.join(resolved, 'api.json');
  try {
    spec = readJSON(apiPath);
  } catch (e) {
    problems.push(problem('readApiJson', moduleName,
      `${apiPath} could not be read: ${e.message}`,
      'api.json declares the device, its services and their actions.'));
    return callback(null, {ok: false, module: moduleName, problems: problems});
  }

  // schema.json is optional, but present-and-malformed is not legal
  try {
    handlerMapModule.readRootSchema(resolved, moduleName);
  } catch (e) {
    problems.push(problem('readRootSchema', moduleName, e.message,
      'schema.json must be valid JSON when present.'));
  }

  let resolvedMap = null;
  try {
    resolvedMap = handlerMapModule.resolveHandlerMap(resolved, loaded.exported, (f) => require(f));
  } catch (e) {
    problems.push(problem('resolveHandlerMap', moduleName,
      `handler map could not be loaded: ${e.message}`,
      'A handler file threw while being required.'));
  }

  if (resolvedMap == null) {
    problems.push(problem('resolveHandlerMap', moduleName,
      `${moduleName}: no handler map found -- neither a handlers/ directory nor a handler-map export.`,
      'This may be a legacy discovery-style module, which the runtime still ' +
      'supports but this validator cannot check beyond its spec.'));
  } else {
    handlerMapLib.validateHandlerMap(spec, resolvedMap.handlerMap, moduleName)
      .forEach((message) => {
        problems.push(problem('assembleHandlerMap', moduleName, message, null));
      });
  }

  return validator.validateDeviceSpec(spec, (specErr) => {
    if (specErr != null) specProblems(specErr, moduleName).forEach((p) => problems.push(p));
    return callback(null, {ok: problems.length === 0, module: moduleName, problems: problems});
  });
}

module.exports = {
  validateModule: validateModule
};
```

- [ ] **Step 4: Export `readRootSchema` so the validator can reach it**

`lib/handler-map-module.js` currently exports only `resolveHandlerMap`, `assemble` and `HandlerMapModule`. Add `readRootSchema` to that export block — the function already exists at the top of the file and is unchanged:

```js
module.exports = {
  resolveHandlerMap: resolveHandlerMap,
  readRootSchema:    readRootSchema,
  assemble:          assemble,
  HandlerMapModule:  HandlerMapModule
};
```

- [ ] **Step 5: Run the tests to verify they pass**

```sh
npx mocha test/module-authoring/01-module-validator.js
```

Expected: all cases PASS. If `invalid-spec-module` or `legacy-spec-module` produce a different stage than expected, read the fixture and adjust the *assertion* to the real behaviour — do not reword validator messages to satisfy a test.

- [ ] **Step 6: Lint and commit**

```sh
npm run lint
git add lib/module-validator.js lib/handler-map-module.js test/module-authoring/01-module-validator.js
git commit -m "feat(authoring): a module validator that needs no server

The checks were already right -- validateHandlerMap collects every problem
with the fix named -- but only reachable by booting framework.js, which
initialises Redis at startup. Authoring is a fix-check-fix loop, and a loop
whose check needs a database is a loop nobody runs.

Wraps the existing checks in structure and leaves their messages
byte-identical, so what an author reads here is what the server logs."
```

---

### Task 2: The CLI — `bin/countinghouse-validate`

**Files:**
- Create: `bin/countinghouse-validate`
- Modify: `package.json` (the `bin` block, and the `test` script)
- Test: `test/module-authoring/02-validate-cli.js`

**Interfaces:**
- Consumes: `validateModule(modulePath, callback)` from Task 1.
- Produces: an executable that exits `0` when `ok`, `1` when there are problems, and `2` when the path is unusable.

- [ ] **Step 1: Write the failing test**

Create `test/module-authoring/02-validate-cli.js`:

```js
// bin/countinghouse-validate is the same oracle as lib/module-validator.js,
// reachable from a shell. It exists for humans, for CI, and for agents that
// can run a command but have no MCP server up.
const assert = require('assert');
const path   = require('path');
const exec   = require('child_process').exec;

const ROOT     = path.join(__dirname, '..', '..');
const BIN      = path.join(ROOT, 'bin', 'countinghouse-validate');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

function run(args, done) {
  exec(`node ${BIN} ${args}`, {cwd: ROOT}, (err, stdout, stderr) => {
    done({code: err == null ? 0 : err.code, stdout: stdout, stderr: stderr});
  });
}

describe('countinghouse-validate CLI', function() {
  this.timeout(20000);

  it('exits 0 and says so for a clean module', (done) => {
    run(path.join(FIXTURES, 'handler-map-convention'), (r) => {
      assert.strictEqual(r.code, 0);
      assert.ok(/ok/i.test(r.stdout), `expected an ok line, got: ${r.stdout}`);
      done();
    });
  });

  it('exits 1 and prints every problem for a broken module', (done) => {
    run(path.join(FIXTURES, 'handler-map-unknown-service'), (r) => {
      assert.strictEqual(r.code, 1);
      assert.ok(/greetingService/.test(r.stdout + r.stderr));
      done();
    });
  });

  it('exits 2 when the path does not exist', (done) => {
    run(path.join(FIXTURES, 'no-such-module-anywhere'), (r) => {
      assert.strictEqual(r.code, 2);
      done();
    });
  });

  it('exits 2 with usage when given no argument', (done) => {
    run('', (r) => {
      assert.strictEqual(r.code, 2);
      assert.ok(/usage/i.test(r.stdout + r.stderr));
      done();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```sh
npx mocha test/module-authoring/02-validate-cli.js
```

Expected: FAIL — the bin does not exist, so every case gets a non-zero code with "Cannot find module".

- [ ] **Step 3: Write the implementation**

Create `bin/countinghouse-validate`:

```js
#!/usr/bin/env node
// Validate a countinghouse module directory without starting a server.
//
//   countinghouse-validate ./my-module
//
// Exit codes are the contract: 0 clean, 1 problems found, 2 could not look.
// Anything reading this programmatically -- CI, an agent -- keys off those.
const path = require('path');

require(path.join(__dirname, '..', 'lib', 'cli-options')).setOptions({});
const moduleValidator = require(path.join(__dirname, '..', 'lib', 'module-validator'));

const target = process.argv[2];

if (target == null || target === '' || target === '-h' || target === '--help') {
  console.log('usage: countinghouse-validate <module-directory>');
  console.log('');
  console.log('Checks api.json, schema.json and the handler map against each other.');
  console.log('Exit codes: 0 = ok, 1 = problems found, 2 = path unusable.');
  process.exit(2);
}

moduleValidator.validateModule(target, (err, result) => {
  if (err != null) {
    console.error(`countinghouse-validate: ${err.message}`);
    process.exit(2);
  }

  if (result.ok === true) {
    console.log(`ok: ${result.module} -- no problems found`);
    process.exit(0);
  }

  console.log(`${result.module}: ${result.problems.length} problem(s)`);
  result.problems.forEach((p) => {
    console.log(`  [${p.stage}] ${p.message}`);
    if (p.fix != null) console.log(`      fix: ${p.fix}`);
  });
  process.exit(1);
});
```

- [ ] **Step 4: Make it executable and register it**

```sh
chmod +x bin/countinghouse-validate
```

In `package.json`, add to the existing `bin` block (keep the other three entries):

```json
"countinghouse-validate": "./bin/countinghouse-validate"
```

And append the new test directory to the `test` script, immediately after the existing `mocha ./test/auth/*.js ...` group:

```
./test/module-authoring/*.js
```

- [ ] **Step 5: Run the tests to verify they pass**

```sh
npx mocha test/module-authoring/02-validate-cli.js
```

Expected: 4 passing.

- [ ] **Step 6: Lint and commit**

```sh
npm run lint
git add bin/countinghouse-validate package.json test/module-authoring/02-validate-cli.js
git commit -m "feat(authoring): countinghouse-validate, the oracle from a shell

Exit codes are the contract -- 0 clean, 1 problems, 2 could not look -- so
CI and agents can branch on the result without parsing prose."
```

---

### Task 3: Gating + the first MCP tool

**Files:**
- Modify: `lib/cli-options.js`
- Modify: `lib/mcp/tool-registry.js:29-40`
- Modify: `lib/mcp/gateway.js` (`handleToolsList` ~line 97, `handleToolsCall` ~line 148)
- Test: `test/module-authoring/03-authoring-tools-gating.js`

**Interfaces:**
- Consumes: `validateModule` (Task 1); `resolveCallerIdentity(appKey, callback)` in `lib/mcp/gateway.js:60`, which calls back `(err, {appKey, isAdmin})`.
- Produces: `AUTHORING_TOOLS` (array of MCP tool definitions) and `AUTHORING_TOOL_NAMES` (name → true) exported from `lib/mcp/tool-registry.js`; the working tool `countinghouse_validate_module`.

**Why gating lives in the gateway:** `tool-registry.js` has no notion of caller identity, while `gateway.js` already resolves `{appKey, isAdmin}`. Defining the tools in the registry (so all platform tool definitions stay in one file) and gating them in the gateway (where identity is known) keeps both concerns where they already belong.

- [ ] **Step 1: Write the failing test**

Create `test/module-authoring/03-authoring-tools-gating.js`:

```js
// The authoring tools are admin-gated AND off unless --authoringTools is
// passed. Default-off is a safety property, not a preference:
// countinghouse_load_module plus countinghouse_call_tool is arbitrary code
// execution with a friendly name, and must not be one flag-flip away on a
// deployment that merely happens to have an admin key configured.
//
// Default-off is also what keeps the golden tools/list surface still --
// test/mcp-contract/capture-tools-list.js never passes the flag -- so the
// first case here is the regression guard for that too.
const assert  = require('assert');
const path    = require('path');
const spawn   = require('child_process').spawn;
const request = require('supertest');

const ROOT = path.join(__dirname, '..', '..');
const AUTHORING_NAMES = [
  'countinghouse_validate_plan',
  'countinghouse_validate_module',
  'countinghouse_load_module',
  'countinghouse_call_tool'
];

function startServer(port, extraArgs, done) {
  const args = ['--debug', '--bindAddr', '127.0.0.1', '--port', String(port),
                '--debugKey', 'aabbcc'].concat(extraArgs);
  const server = spawn(path.join(ROOT, 'bin', 'countinghouse'), args,
                       {cwd: ROOT, stdio: 'ignore', detached: true});
  setTimeout(() => done(server), 6000);
}

function toolsList(port, cb) {
  request(`http://127.0.0.1:${port}`)
    .post('/mcp')
    .set('X-CH-Key', 'aabbcc')
    .send({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})
    .end((err, res) => cb(err, res && res.body && res.body.result));
}

describe('authoring tools: absent unless --authoringTools', function() {
  this.timeout(30000);
  let server = null;
  const PORT = 9550;

  before((done) => { startServer(PORT, [], (s) => { server = s; done(); }); });
  after(() => { if (server != null) process.kill(-server.pid); });

  it('lists none of the four authoring tools', (done) => {
    toolsList(PORT, (err, result) => {
      assert.ifError(err);
      const names = result.tools.map((t) => t.name);
      AUTHORING_NAMES.forEach((n) => {
        assert.ok(names.indexOf(n) === -1, `${n} must not be listed without --authoringTools`);
      });
      done();
    });
  });

  it('refuses to call one even for an admin key', (done) => {
    request(`http://127.0.0.1:${PORT}`)
      .post('/mcp')
      .set('X-CH-Key', 'aabbcc')
      .send({jsonrpc: '2.0', id: 2, method: 'tools/call',
             params: {name: 'countinghouse_validate_module', arguments: {path: '.'}}})
      .end((err, res) => {
        assert.ifError(err);
        assert.ok(res.body.result == null || res.body.result.isError === true,
                  'calling a disabled authoring tool must not succeed');
        done();
      });
  });
});

describe('authoring tools: present with --authoringTools', function() {
  this.timeout(30000);
  let server = null;
  const PORT = 9551;

  before((done) => { startServer(PORT, ['--authoringTools'], (s) => { server = s; done(); }); });
  after(() => { if (server != null) process.kill(-server.pid); });

  it('lists countinghouse_validate_module', (done) => {
    toolsList(PORT, (err, result) => {
      assert.ifError(err);
      const names = result.tools.map((t) => t.name);
      assert.ok(names.indexOf('countinghouse_validate_module') !== -1);
      done();
    });
  });

  it('validates a clean fixture through the tool', (done) => {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-convention');
    request(`http://127.0.0.1:${PORT}`)
      .post('/mcp')
      .set('X-CH-Key', 'aabbcc')
      .send({jsonrpc: '2.0', id: 3, method: 'tools/call',
             params: {name: 'countinghouse_validate_module', arguments: {path: fixture}}})
      .end((err, res) => {
        assert.ifError(err);
        assert.strictEqual(res.body.result.isError, false);
        assert.strictEqual(res.body.result.structuredContent.ok, true);
        done();
      });
  });

  it('returns the full problem list for a broken fixture', (done) => {
    const fixture = path.join(ROOT, 'test', 'fixtures', 'handler-map-unknown-service');
    request(`http://127.0.0.1:${PORT}`)
      .post('/mcp')
      .set('X-CH-Key', 'aabbcc')
      .send({jsonrpc: '2.0', id: 4, method: 'tools/call',
             params: {name: 'countinghouse_validate_module', arguments: {path: fixture}}})
      .end((err, res) => {
        assert.ifError(err);
        const out = res.body.result.structuredContent;
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.problems.length, 2);
        done();
      });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```sh
npx mocha test/module-authoring/03-authoring-tools-gating.js
```

Expected: the "absent" cases may pass vacuously (the tools do not exist yet); the "present with --authoringTools" cases FAIL because the tool is never listed.

- [ ] **Step 3: Add the CLI flag**

In `lib/cli-options.js`, in `setOptions`, beside the other booleans:

```js
    this.authoringTools          = (argv.authoringTools  === true) ? true : false;
```

and in `getOptions`'s returned object:

```js
      authoringTools:           this.authoringTools,
```

- [ ] **Step 4: Define the tools in the registry**

In `lib/mcp/tool-registry.js`, after the existing `PLATFORM_TOOLS` array (~line 40), add:

```js
// Authoring tools: admin-gated AND off unless --authoringTools. Defined here
// so every platform tool definition lives in one file, but gated in
// gateway.js, which is where caller identity is resolved.
//
// Their names are reserved unconditionally (below), even when the flag is
// off: reserving costs nothing, and it means enabling the flag can never
// collide with a device tool that had already taken the name.
const AUTHORING_TOOL_NAMES = {
  'countinghouse_validate_plan':   true,
  'countinghouse_validate_module': true,
  'countinghouse_load_module':     true,
  'countinghouse_call_tool':       true
};

const PROBLEM_LIST_SCHEMA = {
  type: 'object',
  properties: {
    ok:      {type: 'boolean'},
    module:  {type: 'string'},
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stage:   {type: 'string'},
          module:  {type: 'string'},
          message: {type: 'string'},
          fix:     {type: ['string', 'null']}
        }
      }
    }
  }
};

const AUTHORING_TOOLS = [
  {
    name: 'countinghouse_validate_module',
    description: 'Validate a countinghouse module directory: api.json, schema.json and the ' +
                 'handler map checked against each other. Returns every problem found, not ' +
                 'just the first, each naming the stage and the way out.',
    inputSchema: {
      type: 'object',
      properties: {path: {type: 'string', description: 'Absolute path to the module directory.'}},
      required: ['path']
    },
    outputSchema: PROBLEM_LIST_SCHEMA
  }
];
```

Reserve the names alongside the existing reservation in `buildToolTargets` (~line 61):

```js
  for (const reserved in PLATFORM_TOOL_NAMES)  usedNames[reserved] = true;
  for (const reserved in AUTHORING_TOOL_NAMES) usedNames[reserved] = true;
```

And add both to the export block at the bottom of the file:

```js
  AUTHORING_TOOLS:      AUTHORING_TOOLS,
  AUTHORING_TOOL_NAMES: AUTHORING_TOOL_NAMES
```

- [ ] **Step 5: List and dispatch them in the gateway**

At the top of `lib/mcp/gateway.js`, alongside the existing requires, add:

```js
const options         = require('../cli-options');
const moduleValidator = require('../module-validator');
```

(If `options` is already required in this file, do not require it twice.)

Replace `handleToolsList` (currently at `lib/mcp/gateway.js:97`) with:

```js
function handleToolsList(req, cdifInterface, appKey, callback) {
  toolRegistry.buildToolList(cdifInterface, appKey, (err, tools) => {
    if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));

    // Authoring tools are appended rather than built into buildToolList
    // because listing them needs isAdmin, which only this layer resolves.
    if (options.getOptions().authoringTools !== true) {
      return callback(null, resultResponse(req.id, {tools: tools}));
    }
    return resolveCallerIdentity(appKey, (authErr, authCtx) => {
      if (authErr != null || authCtx.isAdmin !== true) {
        return callback(null, resultResponse(req.id, {tools: tools}));
      }
      return callback(null, resultResponse(req.id, {tools: tools.concat(toolRegistry.AUTHORING_TOOLS)}));
    });
  });
}
```

Add a dispatch helper above `handleToolsCall`:

```js
// Every authoring tool takes the same two gates: the flag, then admin. A
// disabled tool answers exactly like an unknown one -- a caller without the
// flag should not be able to tell the feature exists.
function dispatchAuthoringTool(req, name, toolArgs, appKey, callback) {
  if (options.getOptions().authoringTools !== true) return false;

  resolveCallerIdentity(appKey, (authErr, authCtx) => {
    if (authErr != null) {
      return callback(null, resultResponse(req.id, toolCallResult(authErr)));
    }
    if (authCtx.isAdmin !== true) {
      const err = new Error('authoring tools require an admin key');
      err.code = 'ADMIN_REQUIRED';
      return callback(null, resultResponse(req.id, toolCallResult(err)));
    }

    if (name === 'countinghouse_validate_module') {
      if (typeof(toolArgs.path) !== 'string' || toolArgs.path === '') {
        return callback(null, resultResponse(req.id, toolCallResult(new Error('arguments.path must be a non-empty string'))));
      }
      return moduleValidator.validateModule(toolArgs.path, (vErr, result) => {
        return callback(null, resultResponse(req.id, toolCallResult(vErr, result)));
      });
    }

    return callback(null, resultResponse(req.id, toolCallResult(new Error(`unknown authoring tool: ${name}`))));
  });
  return true;
}
```

Then, in `handleToolsCall`, immediately after the existing `countinghouse_check_balance` block, add:

```js
  if (toolRegistry.AUTHORING_TOOL_NAMES[name] === true) {
    if (dispatchAuthoringTool(req, name, toolArgs, appKey, callback) === true) return;
    // flag off: answer as for any unknown tool, so the feature stays invisible
    return callback(null, resultResponse(req.id, toolCallResult(new Error(`unknown tool: ${name}`))));
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```sh
npx mocha test/module-authoring/03-authoring-tools-gating.js
```

Expected: 5 passing. Requires Redis on 6379.

- [ ] **Step 7: Confirm the golden surface has not moved**

```sh
npm run golden
```

Expected: 7 passing. **If this fails, stop** — it means the tools are leaking into the default surface, which is the one thing this task must not do.

- [ ] **Step 8: Lint and commit**

```sh
npm run lint
git add lib/cli-options.js lib/mcp/tool-registry.js lib/mcp/gateway.js test/module-authoring/03-authoring-tools-gating.js
git commit -m "feat(authoring): --authoringTools, and countinghouse_validate_module

Two gates, not one: the flag and an admin key. load_module plus call_tool
is arbitrary code execution with a friendly name, so it must not be one
flag-flip away on a deployment that merely happens to have an admin key.

A disabled tool answers exactly like an unknown one, so a caller without
the flag cannot tell the feature exists. Default-off also leaves the golden
tools/list surface untouched -- capture-tools-list.js never passes the flag."
```

---

### Task 4: `countinghouse_load_module` and `countinghouse_call_tool`

**Files:**
- Modify: `lib/mcp/tool-registry.js` (extend `AUTHORING_TOOLS`)
- Modify: `lib/mcp/gateway.js` (extend `dispatchAuthoringTool`)
- Test: `test/module-authoring/04-authoring-loop.js`

**Interfaces:**
- Consumes: `cdifInterface.deviceManager.moduleManager.loadModuleFromPath(path, name, version, callback)` — **verified**: `CdifInterface` does not store the module manager itself (`lib/countinghouse-interface.js:18-19` passes it straight to `DeviceManager`), which keeps it at `lib/device-manager.js:43` as `this.moduleManager`. `toolRegistry.buildToolTargets(cdifInterface)` (synchronous, returns `{toolName: target}`).
- Produces: `countinghouse_load_module` returning `{loaded, name, version, toolNames}`; `countinghouse_call_tool` returning the same result shape `tools/call` produces.

**Why `toolNames` matters:** `buildToolList` recomputes from live device specs on every request (`lib/mcp/tool-registry.js:181`), so a loaded module *does* appear on the next `tools/list`. What is missing is `notifications/tools/list_changed` — nothing tells the client to re-ask. Returning the names it just made callable, plus `call_tool` to invoke them, closes the loop without giving the transport a server→client channel it does not have.

- [ ] **Step 1: Write the failing test**

Create `test/module-authoring/04-authoring-loop.js`:

```js
// The loop the whole feature exists for: validate a module, load it, and call
// the tool that just appeared -- without the agent's MCP client ever being
// told its tool list changed.
//
// That last part is the point of countinghouse_call_tool. The server is
// already correct (buildToolList recomputes per request), but no
// notifications/tools/list_changed is ever sent, so a client holding a cached
// list would not know to re-ask. The agent calls by name instead.
const assert  = require('assert');
const path    = require('path');
const spawn   = require('child_process').spawn;
const request = require('supertest');

const ROOT    = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'handler-map-convention');
const PORT    = 9552;

function mcp(method, params, cb) {
  request(`http://127.0.0.1:${PORT}`)
    .post('/mcp')
    .set('X-CH-Key', 'aabbcc')
    .send({jsonrpc: '2.0', id: Date.now(), method: method, params: params})
    .end((err, res) => cb(err, res && res.body));
}

const call = (name, args, cb) => mcp('tools/call', {name: name, arguments: args}, cb);

describe('the authoring loop', function() {
  this.timeout(40000);
  let server = null;

  before((done) => {
    server = spawn(path.join(ROOT, 'bin', 'countinghouse'),
                   ['--debug', '--bindAddr', '127.0.0.1', '--port', String(PORT),
                    '--debugKey', 'aabbcc', '--authoringTools', '--workerThread'],
                   {cwd: ROOT, stdio: 'ignore', detached: true});
    setTimeout(done, 8000);
  });
  after(() => { if (server != null) process.kill(-server.pid); });

  let loadedToolName = null;

  it('validates the module before loading it', (done) => {
    call('countinghouse_validate_module', {path: FIXTURE}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.structuredContent.ok, true);
      done();
    });
  });

  it('loads it and reports the tool names it made callable', (done) => {
    call('countinghouse_load_module',
         {path: FIXTURE, name: 'handler-map-convention', version: '1.0.0'}, (err, body) => {
      assert.ifError(err);
      const out = body.result.structuredContent;
      assert.strictEqual(out.loaded, true);
      assert.ok(Array.isArray(out.toolNames) && out.toolNames.length > 0,
                'load_module must report the tools it made callable');
      loadedToolName = out.toolNames.find((n) => /hello/.test(n));
      assert.ok(loadedToolName != null, `expected a hello tool, got ${out.toolNames.join(', ')}`);
      done();
    });
  });

  it('calls the freshly loaded tool by name', (done) => {
    call('countinghouse_call_tool',
         {name: loadedToolName, arguments: {name: 'world'}}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, false);
      done();
    });
  });

  it('refuses call_tool for a name that does not exist', (done) => {
    call('countinghouse_call_tool', {name: 'no_such_tool_at_all', arguments: {}}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true);
      done();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```sh
npx mocha test/module-authoring/04-authoring-loop.js
```

Expected: the first case passes (Task 3 shipped it); the load and call cases FAIL with an unknown-tool error.

- [ ] **Step 3: Add the two tool definitions**

Append to `AUTHORING_TOOLS` in `lib/mcp/tool-registry.js`:

```js
  {
    name: 'countinghouse_load_module',
    description: 'Load a countinghouse module from a local path into this running runtime, ' +
                 'and report the MCP tool names it made callable. Admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        path:    {type: 'string', description: 'Absolute path to the module directory.'},
        name:    {type: 'string', description: 'Module name to register it under.'},
        version: {type: 'string', description: 'Module version, e.g. 1.0.0.'}
      },
      required: ['path', 'name']
    },
    outputSchema: {
      type: 'object',
      properties: {
        loaded:    {type: 'boolean'},
        name:      {type: 'string'},
        version:   {type: ['string', 'null']},
        toolNames: {type: 'array', items: {type: 'string'}}
      }
    }
  },
  {
    name: 'countinghouse_call_tool',
    description: 'Invoke a tool on this runtime by name. Exists so a just-loaded module can ' +
                 'be called without waiting for the MCP client to refresh its tool list.',
    inputSchema: {
      type: 'object',
      properties: {
        name:      {type: 'string', description: 'The MCP tool name to invoke.'},
        arguments: {type: 'object', description: 'Arguments for that tool.'}
      },
      required: ['name']
    },
    outputSchema: {type: 'object'}
  }
```

- [ ] **Step 4: Dispatch them**

In `lib/mcp/gateway.js`, inside `dispatchAuthoringTool`, after the `countinghouse_validate_module` branch:

```js
    if (name === 'countinghouse_load_module') {
      if (typeof(toolArgs.path) !== 'string' || typeof(toolArgs.name) !== 'string') {
        return callback(null, resultResponse(req.id, toolCallResult(new Error('arguments.path and arguments.name are required'))));
      }
      const before = Object.keys(toolRegistry.buildToolTargets(cdifInterface));
      return cdifInterface.deviceManager.moduleManager.loadModuleFromPath(
        toolArgs.path, toolArgs.name, toolArgs.version || null, (loadErr) => {
          if (loadErr != null) {
            return callback(null, resultResponse(req.id, toolCallResult(loadErr)));
          }
          // Diffing before/after is what turns "it loaded" into "here is what
          // you can now call" -- the module's tool names are derived from its
          // spec, not from anything the caller passed in.
          const after = Object.keys(toolRegistry.buildToolTargets(cdifInterface));
          const added = after.filter((n) => before.indexOf(n) === -1);
          return callback(null, resultResponse(req.id, toolCallResult(null, {
            loaded:    true,
            name:      toolArgs.name,
            version:   toolArgs.version || null,
            toolNames: added
          })));
        });
    }

    if (name === 'countinghouse_call_tool') {
      if (typeof(toolArgs.name) !== 'string' || toolArgs.name === '') {
        return callback(null, resultResponse(req.id, toolCallResult(new Error('arguments.name must be a non-empty string'))));
      }
      if (toolRegistry.AUTHORING_TOOL_NAMES[toolArgs.name] === true) {
        return callback(null, resultResponse(req.id, toolCallResult(new Error('countinghouse_call_tool cannot invoke an authoring tool'))));
      }
      // Re-enter the normal tools/call path so the inner call gets the same
      // auth, validation, metering and timeout every other call gets. This is
      // a convenience for clients with a stale tool list, not a second,
      // weaker entry point.
      const innerReq = {
        id:     req.id,
        params: {name: toolArgs.name, arguments: toolArgs.arguments || {}}
      };
      return handleToolsCall(innerReq, cdifInterface, appKey, callback);
    }
```

`dispatchAuthoringTool` needs `cdifInterface`; change its signature and its one call site to pass it:

```js
function dispatchAuthoringTool(req, name, toolArgs, cdifInterface, appKey, callback) {
```

```js
    if (dispatchAuthoringTool(req, name, toolArgs, cdifInterface, appKey, callback) === true) return;
```

- [ ] **Step 5: Confirm the module-manager path still holds**

`lib/routes/load-module.js` receives `mm` directly, but the gateway only has
`cdifInterface`. The path above (`cdifInterface.deviceManager.moduleManager`)
was verified against the code — `CdifInterface` takes `mm` and hands it to
`DeviceManager` without keeping a reference
(`lib/countinghouse-interface.js:18-19`), and `DeviceManager` stores it as
`this.moduleManager` (`lib/device-manager.js:43`). Re-confirm it in one
command before trusting it:

```sh
grep -n 'this.moduleManager' lib/device-manager.js
```

Expected: line 43. If that has moved, follow the real property rather than
adding a new one to `CdifInterface`.

- [ ] **Step 6: Run the tests to verify they pass**

```sh
npx mocha test/module-authoring/04-authoring-loop.js
```

Expected: 4 passing.

- [ ] **Step 7: Lint, check the surface, and commit**

```sh
npm run lint && npm run golden
git add lib/mcp/tool-registry.js lib/mcp/gateway.js test/module-authoring/04-authoring-loop.js
git commit -m "feat(authoring): load_module and call_tool, closing the loop

The server was already right -- buildToolList recomputes per request, so a
loaded module appears on the next tools/list. What is missing is the
listChanged notification, and sending one would cost the statelessness the
transport was chosen for.

So load_module returns the tool names it made callable and call_tool
invokes them by name, re-entering the normal tools/call path so the inner
call gets the same auth, validation, metering and timeout as any other."
```

---

### Task 5: `countinghouse_validate_plan`

**Files:**
- Create: `lib/mcp/tool-name.js`
- Modify: `lib/mcp/tool-registry.js:13-16` (move `slugify` out, re-export it) and extend `AUTHORING_TOOLS`
- Modify: `lib/mcp/gateway.js` (extend `dispatchAuthoringTool`)
- Create: `lib/plan-validator.js`
- Test: `test/module-authoring/05-validate-plan.js`

**Interfaces:**
- Consumes: `slugify(s)` from the new `lib/mcp/tool-name.js`; `toolRegistry.buildToolTargets(cdifInterface)` for live-name collisions (called in the gateway, not in the validator).

**Why `slugify` moves:** `lib/plan-validator.js` must predict the tool names a plan would produce, and `slugify` is the source of truth for that. But requiring `lib/mcp/tool-registry.js` opens a Redis socket and a timer at require time (verified: it leaves `TCPSocketWrap` and `Timeout` active), which would hang a mocha run that has no `--exit`. Extracting the one pure function keeps a single source of truth *and* keeps the validator hermetic — the same property that makes Task 1 worth doing.
- Produces: `validatePlan(plan, existingToolNames)` → `{ok, problems[]}`, same `Problem` shape as Task 1.

**Scope note:** this is the tool the spec marks as the deliberate cut candidate. Build it, then watch whether agents actually call it before writing files. If they skip it, delete it.

- [ ] **Step 1: Write the failing test**

Create `test/module-authoring/05-validate-plan.js`:

```js
// validate_plan checks a proposed service/action split before any file
// exists, so the user has something readable to approve and the agent gets a
// cheap early failure instead of a slow one after writing four files.
const assert = require('assert');

require('../../lib/cli-options').setOptions({});
const planValidator = require('../../lib/plan-validator');

const goodPlan = {
  device: 'log-review',
  services: [{
    name: 'reviewService',
    actions: [{name: 'summarize', description: 'Summarize error logs by service.'}]
  }]
};

describe('plan-validator', () => {
  it('accepts a well-formed plan', () => {
    const r = planValidator.validatePlan(goodPlan, []);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.problems, []);
  });

  it('rejects a plan with no services', () => {
    const r = planValidator.validatePlan({device: 'x', services: []}, []);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => p.stage === 'validatePlan'));
  });

  it('rejects an action with no description, which MCP needs', () => {
    const plan = {device: 'x', services: [{name: 'svc', actions: [{name: 'go'}]}]};
    const r = planValidator.validatePlan(plan, []);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => /description/.test(p.message)));
  });

  it('rejects two services sharing a short name', () => {
    const plan = {device: 'x', services: [
      {name: 'svc', actions: [{name: 'a', description: 'd'}]},
      {name: 'svc', actions: [{name: 'b', description: 'd'}]}
    ]};
    const r = planValidator.validatePlan(plan, []);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => /ambiguous|duplicate/i.test(p.message)));
  });

  it('rejects two actions sharing a name within one service', () => {
    const plan = {device: 'x', services: [
      {name: 'svc', actions: [{name: 'a', description: 'd'}, {name: 'a', description: 'd'}]}
    ]};
    const r = planValidator.validatePlan(plan, []);
    assert.strictEqual(r.ok, false);
  });

  it('reports a collision with a tool already on the runtime', () => {
    const r = planValidator.validatePlan(goodPlan, ['log_review_reviewservice_summarize']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.problems.some((p) => /already/i.test(p.message)));
  });

  it('reports the tool names the plan would produce', () => {
    const r = planValidator.validatePlan(goodPlan, []);
    assert.ok(Array.isArray(r.toolNames));
    assert.strictEqual(r.toolNames.length, 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```sh
npx mocha test/module-authoring/05-validate-plan.js
```

Expected: FAIL with `Cannot find module '../../lib/plan-validator'`.

- [ ] **Step 3: Extract `slugify` into its own module**

Create `lib/mcp/tool-name.js`:

```js
// The one rule for turning a device/service/action name into an MCP tool
// name. It lives alone, with no requires, so anything that needs to predict a
// tool name can have it without dragging in tool-registry.js -- which opens a
// Redis socket at require time and would keep a test process alive.
function slugify(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return out === '' ? 'x' : out;
}

module.exports = {
  slugify: slugify
};
```

In `lib/mcp/tool-registry.js`, delete the local `slugify` definition at lines
13-16 and require it instead, keeping the existing export so every current
caller is unaffected:

```js
const slugify = require('./tool-name').slugify;
```

Verify nothing else broke:

```sh
npm run lint && npm run golden
```

Expected: lint clean, golden 7 passing.

- [ ] **Step 4: Write the implementation**

Create `lib/plan-validator.js`:

```js
// Checks a proposed service/action split before any file exists.
//
// The value is not that it catches things lib/module-validator.js would miss
// -- it catches a subset, earlier. An agent that has already written four
// files and then learns the tool name collides has wasted the write; an agent
// that learns it from a plan has not. It also gives the user something short
// and readable to approve before code appears, which is where requirement
// analysis actually belongs.
const slugify = require('./mcp/tool-name').slugify;

function problem(message, fix) {
  return {stage: 'validatePlan', module: null, message: message, fix: fix || null};
}

// Mirrors how tool-registry names a device tool, so the names reported here
// are the names that will actually appear in tools/list.
function predictedToolName(deviceName, serviceName, actionName) {
  return [slugify(deviceName), slugify(serviceName), slugify(actionName)].join('_');
}

function validatePlan(plan, existingToolNames) {
  const problems = [];
  const existing = existingToolNames || [];
  const toolNames = [];

  if (plan == null || typeof(plan.device) !== 'string' || plan.device === '') {
    problems.push(problem('plan.device must be a non-empty string.',
                          'This becomes the device friendlyName in api.json.'));
    return {ok: false, problems: problems, toolNames: toolNames};
  }

  if (!Array.isArray(plan.services) || plan.services.length === 0) {
    problems.push(problem('plan.services must be a non-empty array.',
                          'A module exposes at least one service, each with at least one action.'));
    return {ok: false, problems: problems, toolNames: toolNames};
  }

  const seenServices = {};

  plan.services.forEach((svc, i) => {
    if (svc == null || typeof(svc.name) !== 'string' || svc.name === '') {
      problems.push(problem(`services[${i}].name must be a non-empty string.`, null));
      return;
    }
    if (seenServices[svc.name] === true) {
      problems.push(problem(`service short name "${svc.name}" is duplicate within this plan.`,
                            'Short names must be unique within a module -- the handler map keys off them.'));
    }
    seenServices[svc.name] = true;

    if (!Array.isArray(svc.actions) || svc.actions.length === 0) {
      problems.push(problem(`service "${svc.name}" declares no actions.`, null));
      return;
    }

    const seenActions = {};
    svc.actions.forEach((action, j) => {
      if (action == null || typeof(action.name) !== 'string' || action.name === '') {
        problems.push(problem(`services[${i}].actions[${j}].name must be a non-empty string.`, null));
        return;
      }
      if (seenActions[action.name] === true) {
        problems.push(problem(`action "${svc.name}.${action.name}" is declared twice.`,
                              'Action names are unique per service.'));
      }
      seenActions[action.name] = true;

      if (typeof(action.description) !== 'string' || action.description === '') {
        problems.push(problem(`action "${svc.name}.${action.name}" has no description.`,
                              'description is what an LLM reads as the MCP tool description; ' +
                              'an action without one is skipped when tools/list is built.'));
      }

      const toolName = predictedToolName(plan.device, svc.name, action.name);
      toolNames.push(toolName);
      if (existing.indexOf(toolName) !== -1) {
        problems.push(problem(`"${toolName}" is already a tool on this runtime.`,
                              'Rename the device, service or action so the generated tool name is unique.'));
      }
    });
  });

  return {ok: problems.length === 0, problems: problems, toolNames: toolNames};
}

module.exports = {
  validatePlan: validatePlan
};
```

- [ ] **Step 5: Run the tests to verify they pass**

```sh
npx mocha test/module-authoring/05-validate-plan.js
```

Expected: 7 passing. If `slugify` produces a different shape than the test's expected collision name, fix the *test's* expected name — `slugify` is the source of truth for how tools are named.

- [ ] **Step 6: Add the tool definition and dispatch**

Append to `AUTHORING_TOOLS` in `lib/mcp/tool-registry.js`:

```js
  {
    name: 'countinghouse_validate_plan',
    description: 'Check a proposed module design -- device, services, actions -- before writing ' +
                 'any files. Reports naming problems, duplicates, missing descriptions and ' +
                 'collisions with tools already on this runtime, plus the tool names the plan would produce.',
    inputSchema: {
      type: 'object',
      properties: {
        device:   {type: 'string', description: 'Device friendlyName for the module.'},
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:    {type: 'string', description: 'Service short name, e.g. greetService.'},
              actions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name:        {type: 'string'},
                    description: {type: 'string'}
                  },
                  required: ['name', 'description']
                }
              }
            },
            required: ['name', 'actions']
          }
        }
      },
      required: ['device', 'services']
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok:        {type: 'boolean'},
        problems:  {type: 'array', items: {type: 'object'}},
        toolNames: {type: 'array', items: {type: 'string'}}
      }
    }
  }
```

In `lib/mcp/gateway.js`, require the plan validator alongside the module validator:

```js
const planValidator = require('../plan-validator');
```

and add a branch inside `dispatchAuthoringTool`:

```js
    if (name === 'countinghouse_validate_plan') {
      const existing = Object.keys(toolRegistry.buildToolTargets(cdifInterface));
      const result   = planValidator.validatePlan(toolArgs, existing);
      return callback(null, resultResponse(req.id, toolCallResult(null, result)));
    }
```

- [ ] **Step 7: Run the whole authoring suite and commit**

```sh
npx mocha test/module-authoring/*.js
npm run lint && npm run golden
git add lib/mcp/tool-name.js lib/plan-validator.js lib/mcp/tool-registry.js lib/mcp/gateway.js test/module-authoring/05-validate-plan.js
git commit -m "feat(authoring): validate_plan, checking a design before files exist

Catches a subset of what module-validator catches, earlier: an agent that
has written four files and then learns the tool name collides has wasted
the write. It also gives the user something short to approve before code
appears, which is where requirement analysis belongs.

Marked in the spec as the deliberate cut candidate -- if agents skip it and
go straight to writing files, delete it."
```

---

### Task 6: The skill

**Files:**
- Create: `.claude/skills/countinghouse-module/SKILL.md`
- Test: manual (see Step 3)

**Interfaces:**
- Consumes: every tool from Tasks 3–5, plus `bin/countinghouse-validate`.
- Produces: no code. This is the piece that makes an agent decompose well rather than merely legally.

- [ ] **Step 1: Write the skill**

Create `.claude/skills/countinghouse-module/SKILL.md`:

```markdown
---
name: countinghouse-module
description: Use when writing a new countinghouse module, or when a user asks for a tool to be hosted on a countinghouse runtime. Covers decomposing a requirement into services and actions, the module file layout, and the validate/load/call loop.
---

# Writing a countinghouse module

A countinghouse module is a directory the runtime loads and exposes as one or
more MCP tools. Your job is to turn a user's requirement into that directory,
with the user approving the design before code exists.

## Decide what it may return, before what it does

The output schema is the guarantee. A tool whose output schema is
`{type: 'object'}` promises nothing; a tool whose output schema has fields for
findings and counts and no field that can hold a file cannot leak a file, no
matter what its handler does or what a model asks it to do.

So the first question is not "what does this tool do" but **"what is this tool
allowed to return?"** Ask the user. If they say "summarize our logs", ask
whether the summary may quote raw log lines. Their answer is a schema
constraint, and encoding it is most of the value they came for.

## Decomposing a requirement

- **One action is one schema-typed operation.** If describing it needs the word
  "and", consider two actions.
- **A service groups related actions** on one device. Most modules need exactly
  one service; reach for a second only when the two groups would sensibly be
  used independently.
- **A chain belongs in a composite action**, not in the model. If the user's
  request is "read X, then check Y, then report" and the intermediate data is
  large or sensitive, that is one action calling others via `ctx.serviceClient`
  — not three tools the model has to join. See `docs/composite-tools.md`.
- **Name for a reader who has never seen it.** The action `description` is what
  an LLM reads to decide whether to call it, and an action with no description
  is skipped entirely when `tools/list` is built.

## Show the split before writing files

Present the proposed device, services, actions and — most importantly — what
each action may return. Wait for the user. This is where a wrong assumption is
cheap; after four files exist it is not.

Then call `countinghouse_validate_plan` to check names, duplicates, missing
descriptions and collisions with tools already on the runtime.

## The layout

```
my-module/
├── package.json   # name and version
├── api.json       # device, services, actions, schema pointers
├── schema.json    # JSON Schema 2020-12 documents
└── handlers/
    └── greetService/      # service SHORT name (after ":serviceID:")
        └── hello.js       # one file per action
```

A handler is `async (input, ctx)`; `input` is already validated.

```js
module.exports = async (input, ctx) => ({output: {text: `hello ${input.name}`}});
```

Full reference: `docs/module-development.md`.

## The loop

1. `countinghouse_validate_plan` — before any file exists.
2. Write `package.json`, `api.json`, `schema.json`, `handlers/`.
3. `countinghouse_validate_module` — repeat until `ok: true`. It returns
   *every* problem, each naming the stage and the fix; do not fix them one per
   run.
4. `countinghouse_load_module` — note the `toolNames` it returns.
5. `countinghouse_call_tool` with one of those names, and real arguments.
6. Show the user the call and its output.

Without a running server, `npx countinghouse-validate ./my-module` is the same
check from a shell (exit 0 clean, 1 problems, 2 unusable path).

The authoring tools need the runtime started with `--authoringTools` and an
admin key. If they are missing from `tools/list`, that is why.

## When it does not appear in tools/list

`docs/module-development.md` has the full checklist. The five that account for
almost everything:

1. `MODULE_NOT_DISCOVERABLE` — `package.json` `main` points at the wrong file.
2. `DEVICE_SPEC_VALIDATION_FAIL` — `api.json` fails the meta-schema; the error
   names the instance path.
3. `MODULE_NO_DEVICE_ONLINE` — a dynamic-discovery module that never emitted
   `deviceonline`.
4. `LOAD_MODULE_FAIL` — the module threw while loading.
5. Loaded but absent — an action with no `description` is skipped, and
   `tools/list` is filtered per apiKey.
```

- [ ] **Step 2: Verify the frontmatter parses**

```sh
head -5 .claude/skills/countinghouse-module/SKILL.md
```

Expected: a `---` delimited block with `name` and `description` on single lines.

- [ ] **Step 3: Manual check**

In a Claude Code session at the repo root, confirm the skill is listed among available skills. If it is not, the frontmatter is malformed — `name` must match the directory name.

- [ ] **Step 4: Commit**

```sh
git add .claude/skills/countinghouse-module/SKILL.md
git commit -m "feat(authoring): ship the module-authoring skill in-repo

Pointing a coding agent at a clone is now enough; nothing to install
separately. The rubric leads with the rule that matters -- decide what a
tool may return before what it does, because the output schema is the
guarantee -- and puts the design in front of the user before files exist."
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (the "Status, and what isn't built" section)
- Modify: `docs/module-development.md` (after "Verifying a spec without starting a server")

**Interfaces:**
- Consumes: everything above. No code.

- [ ] **Step 1: Update `docs/module-development.md`**

Replace the `### Verifying a spec without starting a server` section body with:

```markdown
### Verifying a module without starting a server

```sh
npx countinghouse-validate ./my-module
```

Checks `api.json`, `schema.json` and the handler map against each other and
prints every problem it finds, each naming the stage and the way out. Exit
codes: `0` clean, `1` problems found, `2` the path could not be read. No
Redis and no server required.

`--verifyModule` remains available for checking a module in the context of a
running framework: it makes the framework continue past validation failures
and report everything it finds, rather than stopping at the first one.

```sh
node ./framework.js --verifyModule --loadModule ./path/to/my-module
```

### Letting an agent write the module

Start the runtime with `--authoringTools` and an admin key, and a coding
agent can validate a design, write the module, validate it, load it and call
it without a human editing JSON. The four tools are
`countinghouse_validate_plan`, `countinghouse_validate_module`,
`countinghouse_load_module` and `countinghouse_call_tool`; they are admin-only
and absent from `tools/list` unless the flag is set.

The repo ships the skill that drives them at
`.claude/skills/countinghouse-module/SKILL.md`.
```

- [ ] **Step 2: Update the README's status section**

In `README.md`, in `## Status, and what isn't built`, replace the first paragraph with:

```markdown
In-process composition works only between modules on the same runtime. Modules
must be written to this runtime's format — though not by hand: start with
`--authoringTools` and a coding agent can design, validate, load and call a
module for you, using the four authoring tools and the skill this repo ships at
`.claude/skills/countinghouse-module/`. `npx countinghouse-validate ./my-module`
is the same check from a shell. An importer for servers built on the official
MCP TypeScript SDK is planned and does not exist yet.
```

- [ ] **Step 3: Verify no dead links**

```sh
grep -o 'blob/master/[A-Za-z0-9._/-]*' README.md | sed 's|blob/master/||' | sort -u | \
  while read f; do [ -e "$f" ] || echo "MISSING: $f"; done
```

Expected: no output.

- [ ] **Step 4: Run the full suite and commit**

```sh
npm run lint && npm run golden && npx mocha test/module-authoring/*.js
git add README.md docs/module-development.md
git commit -m "docs: the authoring loop, and a validator that needs no server

module-development.md's verification section led with --verifyModule, which
needs a booted framework and therefore Redis. countinghouse-validate is the
same check from a shell, so it leads now and the flag follows."
```

---

## Verification

After every task, before claiming the work is done:

```sh
export PATH=~/.local/node-v20/bin:$PATH
npm run lint                        # must be clean
npm run golden                      # must be 7 passing, WITHOUT regenerating the sample
npx mocha test/module-authoring/*.js
```

Then the full suite once, at the end:

```sh
npm test
```

`npm test` needs Redis on 6379 and includes `test7.js`, a benchmark that takes
several minutes. During the task loop, run the three commands above instead.

**The golden check is the one that matters most here.** If `npm run golden`
fails at any point, the authoring tools are leaking into the default MCP
surface — which is exactly what default-off gating exists to prevent. Do not
regenerate `tools-list.golden.json` to make it pass.
