# log-triage Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `examples/log-triage`, a second composite example whose metered hop count grows with the number of log files read and is capped by the caller.

**Architecture:** Three leaf modules (`log-read`, `pii-redact`, `error-cluster`) and one composite (`log-triage`) that calls them with `ctx.call`. The composite makes one `list` hop, a concurrent read-then-redact chain per file, and one `cluster` hop: 2N + 2 hops for N files. A seeded generator supplies sample logs; one script verifies the bill on both hop paths and a suite test runs that script.

**Tech Stack:** Node >= 20 (CommonJS), countinghouse 6.0.0 module shape (`package.json` + `api.json` + `schema.json` + `handlers/<service>/<action>.js`), JSON Schema 2020-12, mocha, supertest, Redis for metering.

**Spec:** `docs/superpowers/specs/2026-10-04-log-triage-example-design.md`

## Global Constraints

- No changes under `lib/`. No new npm dependencies; every module's `dependencies` is `{}`.
- All docs and code comments in English (`CLAUDE.md`).
- One task per commit. Before each commit run lint and the functional suite (the `npm test` chain without `test7.js`, the benchmark); run the full `npm test` including `test7.js` once, before Task 6's commit.
- Every Bash call that runs node needs nvm loaded first: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"`.
- Redis must answer at `redis://127.0.0.1:6379`.
- Never start a server on a port a running suite is using. This plan's scripts use 9596 and 9597 only.
- The pre-commit hook lints and checks the golden `tools/list` sample by starting a server; do not commit while a test run is in progress.
- Inner hops = `2N + 2`; caller is charged `2N + 3` at `--mcpToolCallCost 1`; `maxFiles` default 8, maximum 32; `bill` `maxItems` 66.
- Device IDs: `log-read` `fd0eafbd-20da-53e6-9302-681687350a3b`, `pii-redact` `b5048beb-2128-52c0-9cd4-42669f57090f`, `error-cluster` `9f9aab37-b175-5286-81c3-68bdd24bd4f7`, `log-triage` `dad07d2a-9d65-5ef5-af59-05c0160c5fdc`.
- Module identity: `log-triage-internal`. Exposed tool name: `log_triage_triageservice_triage`.

## Review Focus

Inputs the spec implies but does not spell out. Each has a test in the task that owns the code.

1. **A symlink named `x.log` pointing outside the directory** — `log-read` must not list it or read it (Task 2).
2. **CRLF line endings** — lines come back without a trailing `\r`, so the cluster parser still matches (Task 2).
3. **An empty file, and a file with no trailing newline** — `lineCount` is 0 and N respectively, with no phantom empty last line (Task 2).
4. **Lines that are not log lines** (stack-trace continuations, blank lines) and **a message longer than 160 characters** — counted as `unparsed` or capped, never a crash or a schema failure (Task 4).
5. **`maxFiles` larger than the number of files present** — hops follow the files actually read, not the cap (Task 5, verify script).

## Before starting

- [ ] The two prerequisite fixes on `fix/concurrent-hop-billing` are merged to `master` (the verify script in Task 5 fails without them).
- [ ] Branch from `master`: `git switch master && git switch -c feat/log-triage-example`
- [ ] Commit the spec and this plan:

```bash
git add docs/superpowers/specs/2026-10-04-log-triage-example-design.md docs/superpowers/plans/2026-10-04-log-triage-example.md
git commit -m "docs: spec and plan for log-triage, the second composite example"
```

## File Structure

```
examples/log-triage/
├── README.md                     Task 6
├── auth.json                     Task 5   demo-key + log-triage-internal
├── generate-logs.js              Task 1   seeded sample-log generator, exports PLANTED_PII
├── verify-cost-bound.js          Task 5   asserts the bill on both hop paths
├── log-read/                     Task 2   list + read; the only disk access
├── pii-redact/                   Task 3   pure: mask PII, count by type
├── error-cluster/                Task 4   pure: cluster WARN/ERROR lines
└── log-triage/                   Task 5   the composite
test/composition/
├── 10-log-triage-example.js      Task 5   runs verify-cost-bound.js
└── 11-log-triage-units.js        Tasks 1-4  generator + leaf handlers
```

Handlers are called directly in unit tests as `await handler(input)`; each resolves to `{output: ...}`. Handlers use the global `DeviceError` the runtime provides, so the unit test file defines it when absent.

---

### Task 1: Sample-log generator

**Files:**
- Create: `examples/log-triage/generate-logs.js`
- Test: `test/composition/11-log-triage-units.js`

**Interfaces:**
- Produces: `generate({dir, files, lines, seed}) -> string[]` (absolute file paths, sorted); `PLANTED_PII` (`{email, ipv4, phone, card, bearerToken}`, each a string array); `allPlantedValues() -> string[]`. Files are named `app-01.log`, `app-02.log`, …. Every line is `<ISO timestamp> <LEVEL> <message>`.

- [ ] **Step 1: Write the failing test**

Create `test/composition/11-log-triage-units.js`:

```js
// Unit cover for examples/log-triage: the sample-log generator and the three
// leaf handlers, called directly as plain functions -- no server, no Redis.
// The composite is covered end to end by 10-log-triage-example.js.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// Handlers reference the global DeviceError the runtime installs
// (lib/sandbox.js). Outside the runtime it has to be supplied.
if (global.DeviceError == null) {
  global.DeviceError = require('../../lib/countinghouse-error').DeviceError;
}

const EXAMPLE = path.join(__dirname, '..', '..', 'examples', 'log-triage');
const gen     = require(path.join(EXAMPLE, 'generate-logs.js'));

let tmpRoot = null;

before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'log-triage-units-')); });
after(() => { fs.rmSync(tmpRoot, {recursive: true, force: true}); });

function readAll(files) {
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('');
}

describe('log-triage units: generate-logs', () => {
  it('writes the requested number of files, named in order, with the requested line count', () => {
    const files = gen.generate({dir: path.join(tmpRoot, 'g1'), files: 3, lines: 50, seed: 1});

    assert.deepStrictEqual(files.map((f) => path.basename(f)), ['app-01.log', 'app-02.log', 'app-03.log']);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      assert.ok(text.endsWith('\n'));
      assert.strictEqual(text.split('\n').length - 1, 50);
    }
  });

  it('is byte-identical for the same seed and different for another seed', () => {
    const a = readAll(gen.generate({dir: path.join(tmpRoot, 'g2a'), files: 2, lines: 80, seed: 7}));
    const b = readAll(gen.generate({dir: path.join(tmpRoot, 'g2b'), files: 2, lines: 80, seed: 7}));
    const c = readAll(gen.generate({dir: path.join(tmpRoot, 'g2c'), files: 2, lines: 80, seed: 8}));

    assert.strictEqual(a, b);
    assert.notStrictEqual(a, c);
  });

  it('every line is "<ISO timestamp> <LEVEL> <message>"', () => {
    const text = readAll(gen.generate({dir: path.join(tmpRoot, 'g3'), files: 1, lines: 200, seed: 1}));
    const re   = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (DEBUG|INFO|WARN|ERROR) \S.*$/;

    for (const line of text.split('\n').slice(0, -1)) assert.ok(re.test(line), line);
  });

  it('plants every PII value at the default size', () => {
    const text = readAll(gen.generate({dir: path.join(tmpRoot, 'g4'), files: 8, lines: 400, seed: 1}));

    assert.ok(gen.allPlantedValues().length >= 10);
    for (const value of gen.allPlantedValues()) assert.ok(text.includes(value), `missing ${value}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha --exit ./test/composition/11-log-triage-units.js`
Expected: FAIL with `Cannot find module '…/examples/log-triage/generate-logs.js'`

- [ ] **Step 3: Write the generator**

Create `examples/log-triage/generate-logs.js`:

```js
#!/usr/bin/env node
// Sample data for the log-triage demo: a deterministic set of application log
// files with fake PII planted in them.
//
// Deterministic on purpose. The same --seed always writes byte-identical
// files, so a hop count or a cluster count seen on one machine is the count on
// every machine. The PRNG is in this file rather than a dependency for the
// same reason the leaf modules have none: one file a reader can follow.
//
// Every planted value is fake by construction -- example.com addresses, the
// 203.0.113.0/24 documentation range, 555 phone numbers, the standard test
// card number -- and is exported, so a checker can assert that none of them
// survives into a tool response.
const fs   = require('fs');
const path = require('path');

const PLANTED_PII = {
  email:       ['alice.nguyen@example.com', 'bob.ortiz@example.com', 'carol.w@example.com'],
  ipv4:        ['203.0.113.7', '203.0.113.42', '203.0.113.199'],
  phone:       ['+1-202-555-0143', '+1-202-555-0178'],
  card:        ['4111 1111 1111 1111'],
  bearerToken: ['tk_demo_9f8e7d6c5b4a39281706f5e4d3c2b1a0']
};

function allPlantedValues() {
  return [].concat(PLANTED_PII.email, PLANTED_PII.ipv4, PLANTED_PII.phone,
                   PLANTED_PII.card, PLANTED_PII.bearerToken);
}

// mulberry32: small, fast, and good enough to shuffle log templates.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// r: helpers bound to one generation run. `pii(type)` hands values out in
// rotation rather than at random, so every planted value is guaranteed to
// appear once enough PII lines have been written.
// Weights are relative; the WARN/ERROR templates are the ones error-cluster
// is expected to group.
const TEMPLATES = [
  {w: 30, level: 'INFO',  msg: (r) => `request completed in ${r.int(5, 900)}ms status=200 path=/api/orders/${r.int(1000, 99999)}`},
  {w: 14, level: 'DEBUG', msg: (r) => `cache hit key=session:${r.hex(8)}`},
  {w: 6,  level: 'INFO',  msg: (r) => `user login email=${r.pii('email')} from ${r.pii('ipv4')}`},
  {w: 3,  level: 'INFO',  msg: (r) => `sms verification sent to ${r.pii('phone')}`},
  {w: 3,  level: 'DEBUG', msg: (r) => `outbound call header Authorization: Bearer ${r.pii('bearerToken')}`},
  {w: 5,  level: 'WARN',  msg: (r) => `slow query took ${r.int(800, 9000)}ms table=orders`},
  {w: 4,  level: 'WARN',  msg: (r) => `rate limit near threshold for client ${r.pii('ipv4')}`},
  {w: 3,  level: 'WARN',  msg: (r) => `disk usage at ${r.int(80, 99)}% on /var/data`},
  {w: 3,  level: 'WARN',  msg: (r) => `retrying webhook delivery attempt ${r.int(2, 5)} to ${r.pii('email')}`},
  {w: 3,  level: 'WARN',  msg: (r) => `connection pool exhausted, ${r.int(1, 40)} requests waiting`},
  {w: 2,  level: 'WARN',  msg: (r) => `deprecated endpoint /api/v1/orders called by client ${r.int(100, 999)}`},
  {w: 4,  level: 'ERROR', msg: (r) => `upstream timeout after ${r.int(3000, 30000)}ms calling inventory-service request=${r.uuid()}`},
  {w: 3,  level: 'ERROR', msg: (r) => `payment declined for card ${r.pii('card')} order=${r.int(1000, 99999)}`},
  {w: 3,  level: 'ERROR', msg: (r) => `database connection lost to db-${r.int(1, 4)}.internal retry=${r.int(1, 5)}`},
  {w: 2,  level: 'ERROR', msg: (r) => `unhandled exception in worker ${r.int(1, 16)}: TypeError: cannot read properties of undefined`},
  {w: 2,  level: 'ERROR', msg: (r) => `failed to send receipt to ${r.pii('email')}: mailbox unavailable`},
  {w: 2,  level: 'ERROR', msg: (r) => `job ${r.hex(12)} exceeded max attempts, moved to dead letter queue`}
];

const TOTAL_WEIGHT = TEMPLATES.reduce((sum, t) => sum + t.w, 0);

const BASE_TIME_MS = Date.UTC(2026, 8, 1);   // 2026-09-01T00:00:00Z
const DAY_MS       = 24 * 60 * 60 * 1000;

function generate(opts) {
  const o     = opts || {};
  const dir   = path.resolve(o.dir != null ? o.dir : path.join(__dirname, 'sample-logs'));
  const files = o.files != null ? o.files : 8;
  const lines = o.lines != null ? o.lines : 400;
  const seed  = o.seed  != null ? o.seed  : 1;

  const rnd     = mulberry32(seed);
  const cursors = {};
  const r = {
    int: (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1)),
    hex: (n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += Math.floor(rnd() * 16).toString(16);
      return s;
    },
    uuid: () => `${r.hex(8)}-${r.hex(4)}-${r.hex(4)}-${r.hex(4)}-${r.hex(12)}`,
    pii: (type) => {
      const values = PLANTED_PII[type];
      const i = cursors[type] || 0;
      cursors[type] = i + 1;
      return values[i % values.length];
    }
  };

  fs.mkdirSync(dir, {recursive: true});

  const written = [];
  for (let f = 0; f < files; f++) {
    let t   = BASE_TIME_MS + f * DAY_MS;
    let out = '';

    for (let l = 0; l < lines; l++) {
      t += r.int(50, 20000);

      let pick = rnd() * TOTAL_WEIGHT;
      let template = TEMPLATES[TEMPLATES.length - 1];
      for (const candidate of TEMPLATES) {
        pick -= candidate.w;
        if (pick < 0) { template = candidate; break; }
      }

      out += `${new Date(t).toISOString()} ${template.level} ${template.msg(r)}\n`;
    }

    const file = path.join(dir, `app-${String(f + 1).padStart(2, '0')}.log`);
    fs.writeFileSync(file, out);
    written.push(file);
  }

  return written;
}

module.exports = {generate: generate, PLANTED_PII: PLANTED_PII, allPlantedValues: allPlantedValues};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag  = argv[i];
    const value = argv[i + 1];
    if (flag === '--dir' && value != null) opts.dir = value;
    else if ((flag === '--files' || flag === '--lines' || flag === '--seed') && /^\d+$/.test(value || '')) {
      opts[flag.slice(2)] = Number(value);
    } else {
      console.error('usage: node generate-logs.js [--dir <path>] [--files <n>] [--lines <n>] [--seed <n>]');
      process.exit(2);
    }
  }
  const written = generate(opts);
  console.log(`wrote ${written.length} log file(s) to ${path.dirname(written[0] || path.resolve(opts.dir || path.join(__dirname, 'sample-logs')))}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha --exit ./test/composition/11-log-triage-units.js`
Expected: `4 passing`

- [ ] **Step 5: Lint, suite, commit**

Run: `npm run lint` — expected: clean. Run the functional suite — expected: 0 failing.

```bash
git add examples/log-triage/generate-logs.js test/composition/11-log-triage-units.js
git commit -m "examples(log-triage): a seeded sample-log generator with planted fake PII"
```

---

### Task 2: `log-read` module

**Files:**
- Create: `examples/log-triage/log-read/package.json`, `api.json`, `schema.json`
- Create: `examples/log-triage/log-read/handlers/readService/list.js`, `read.js`
- Test: `test/composition/11-log-triage-units.js` (append)

**Interfaces:**
- Consumes: `gen.generate` from Task 1 (tests only).
- Produces: address `log-read/readService.list`, input `{dir?}`, output `{dir, files: [{name, bytes}]}`; address `log-read/readService.read`, input `{dir?, name, maxBytes?}`, output `{name, bytes, lineCount, truncated, lines}`. Errors are `DeviceError('ARGUMENTS_INVALID', …)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/composition/11-log-triage-units.js`:

```js
describe('log-triage units: log-read', () => {
  const list = require(path.join(EXAMPLE, 'log-read', 'handlers', 'readService', 'list.js'));
  const read = require(path.join(EXAMPLE, 'log-read', 'handlers', 'readService', 'read.js'));

  let dir = null;

  before(() => {
    dir = path.join(tmpRoot, 'read');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'b.log'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(dir, 'a.log'), 'alpha\r\nbeta\r\n');
    fs.writeFileSync(path.join(dir, 'empty.log'), '');
    fs.writeFileSync(path.join(dir, 'no-newline.log'), 'x\ny');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a log');
    fs.mkdirSync(path.join(dir, 'nested.log'));
    fs.writeFileSync(path.join(tmpRoot, 'outside.txt'), 'SECRET OUTSIDE\n');
    fs.symlinkSync(path.join(tmpRoot, 'outside.txt'), path.join(dir, 'link.log'));
  });

  async function rejectsInvalid(promise) {
    await assert.rejects(promise, (err) => err.code === 'ARGUMENTS_INVALID');
  }

  it('list returns only regular *.log files, sorted by name, with sizes', async () => {
    const {output} = await list({dir: dir});

    assert.strictEqual(output.dir, dir);
    assert.deepStrictEqual(output.files, [
      {name: 'a.log', bytes: 13},
      {name: 'b.log', bytes: 14},
      {name: 'empty.log', bytes: 0},
      {name: 'no-newline.log', bytes: 3}
    ]);
  });

  it('list rejects a directory that does not exist', async () => {
    await rejectsInvalid(list({dir: path.join(tmpRoot, 'nope')}));
  });

  it('read returns the lines of one file', async () => {
    const {output} = await read({dir: dir, name: 'b.log'});

    assert.deepStrictEqual(output, {name: 'b.log', bytes: 14, lineCount: 3, truncated: false,
                                    lines: ['one', 'two', 'three']});
  });

  it('read strips the carriage return from CRLF lines', async () => {
    const {output} = await read({dir: dir, name: 'a.log'});
    assert.deepStrictEqual(output.lines, ['alpha', 'beta']);
  });

  it('read handles an empty file and a file with no trailing newline', async () => {
    assert.deepStrictEqual((await read({dir: dir, name: 'empty.log'})).output.lines, []);
    assert.deepStrictEqual((await read({dir: dir, name: 'no-newline.log'})).output.lines, ['x', 'y']);
  });

  it('read stops at the last complete line inside maxBytes and says so', async () => {
    const {output} = await read({dir: dir, name: 'b.log', maxBytes: 9});   // "one\ntwo\nt"

    assert.deepStrictEqual(output.lines, ['one', 'two']);
    assert.strictEqual(output.truncated, true);
    assert.strictEqual(output.bytes, 14);
  });

  it('read rejects any name that is not a bare *.log file name', async () => {
    for (const name of ['../outside.txt', '../read/b.log', 'sub/b.log', 'notes.txt', '.log', '', 'b.log/', 42]) {
      await rejectsInvalid(read({dir: dir, name: name}));
    }
  });

  it('read rejects a symlink and a directory even when they are named *.log', async () => {
    await rejectsInvalid(read({dir: dir, name: 'link.log'}));
    await rejectsInvalid(read({dir: dir, name: 'nested.log'}));
  });

  it('read rejects a non-positive or non-integer maxBytes', async () => {
    await rejectsInvalid(read({dir: dir, name: 'b.log', maxBytes: 0}));
    await rejectsInvalid(read({dir: dir, name: 'b.log', maxBytes: 1.5}));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha --exit ./test/composition/11-log-triage-units.js`
Expected: FAIL with `Cannot find module '…/log-read/handlers/readService/list.js'`; the four Task 1 tests are not reached because the `require` throws while the file loads.

- [ ] **Step 3: Write the module**

`examples/log-triage/log-read/package.json`:

```json
{
  "name": "log-read",
  "version": "1.0.0",
  "description": "lists and reads the *.log files in one directory -- the bulk-data leaf of the log-triage composite demo, and the only module in it that touches the disk",
  "dependencies": {},
  "devDependencies": {},
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "author": "mchen6",
  "license": "Apache-2.0"
}
```

`examples/log-triage/log-read/api.json`:

```json
{
  "device": {
    "friendlyName": "log-read",
    "manufacturer": "countinghouse",
    "modelDescription": "Lists and reads the *.log files directly inside one directory. It is the bulk-data leaf of the log-triage composite demo and the only module in that chain that touches the disk: it returns raw log lines, unmasked, which is exactly why the demo exposes the composite to callers and not this module.",
    "publishAudit": true,
    "iconList": [
      {
        "mimetype": "image/png",
        "width": 88,
        "height": 88,
        "depth": 8,
        "url": "/images/API.png"
      }
    ],
    "serviceList": {
      "urn:countinghouse-com:serviceID:readService": {
        "actionList": [
          {
            "name": "list",
            "description": "Lists the regular files ending in .log directly inside a directory, sorted by name, with each file's size in bytes. Not recursive, and symbolic links are left out. Defaults to the log-triage demo's generated sample directory. Returns at most 256 entries.",
            "input": {
              "schema": "/readService/list/input"
            },
            "output": {
              "schema": "/readService/list/output"
            },
            "fault": {
              "schema": "/fault/readService/list/fault"
            }
          },
          {
            "name": "read",
            "description": "Returns the raw lines of one .log file. `name` must be a bare file name ending in .log, as returned by `list`: a name containing a path separator is refused, and so is a symbolic link, so this action cannot be steered outside the directory it was given. A file larger than `maxBytes` is read up to the last complete line that fits and reported as truncated. The lines are returned unmasked -- anything sensitive in the file is in the response.",
            "input": {
              "schema": "/readService/read/input"
            },
            "output": {
              "schema": "/readService/read/output"
            },
            "fault": {
              "schema": "/fault/readService/read/fault"
            }
          }
        ]
      }
    }
  }
}
```

`examples/log-triage/log-read/schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/",
  "type": "object",
  "readService": {
    "list": {
      "input": {
        "type": "object",
        "properties": {
          "dir": {
            "title": "directory to list",
            "description": "Defaults to examples/log-triage/sample-logs, which `node examples/log-triage/generate-logs.js` fills.",
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          }
        },
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": {
          "dir": {"title": "the resolved directory that was listed", "type": "string"},
          "files": {
            "title": "regular *.log files, sorted by name",
            "type": "array",
            "maxItems": 256,
            "items": {
              "type": "object",
              "properties": {
                "name":  {"title": "file name, no directory part", "type": "string"},
                "bytes": {"title": "file size in bytes", "type": "integer"}
              },
              "required": ["name", "bytes"],
              "additionalProperties": false
            }
          }
        },
        "required": ["dir", "files"],
        "additionalProperties": false
      }
    },
    "read": {
      "input": {
        "type": "object",
        "properties": {
          "dir": {
            "title": "directory the file is in",
            "description": "Same default as `list`.",
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "name": {
            "title": "bare file name ending in .log",
            "type": "string",
            "minLength": 1,
            "maxLength": 255
          },
          "maxBytes": {
            "title": "byte budget for the read",
            "description": "Defaults to 1048576. A larger file is cut at the last complete line that fits.",
            "type": "integer",
            "minimum": 1
          }
        },
        "required": ["name"],
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": {
          "name":      {"title": "file name as requested", "type": "string"},
          "bytes":     {"title": "size of the whole file on disk", "type": "integer"},
          "lineCount": {"title": "number of lines returned", "type": "integer"},
          "truncated": {"title": "whether maxBytes cut the read short", "type": "boolean"},
          "lines": {
            "title": "raw lines, line terminators removed",
            "type": "array",
            "items": {"type": "string"}
          }
        },
        "required": ["name", "bytes", "lineCount", "truncated", "lines"],
        "additionalProperties": false
      }
    }
  },

  "fault": {
    "readService": {
      "list": {
        "fault": {
          "type": "object",
          "properties": {
            "reason": {"title": "specific error reason", "type": "string"},
            "info":   {"title": "detailed error info", "type": "string"}
          }
        }
      },
      "read": {
        "fault": {
          "type": "object",
          "properties": {
            "reason": {"title": "specific error reason", "type": "string"},
            "info":   {"title": "detailed error info", "type": "string"}
          }
        }
      }
    }
  }
}
```

`examples/log-triage/log-read/handlers/readService/list.js`:

```js
// log-read/list: which log files exist. One hop of the log-triage composite;
// the composite reads the answer to decide how many more hops it will make.
const fs   = require('fs');
const path = require('path');

// examples/log-triage/log-read/handlers/readService/ -> up three.
const DEFAULT_DIR = path.resolve(__dirname, '..', '..', '..', 'sample-logs');

const MAX_FILES = 256;

module.exports = async (input) => {
  const opts = input || {};

  if (opts.dir != null && (typeof opts.dir !== 'string' || opts.dir === '')) {
    throw new DeviceError('ARGUMENTS_INVALID', 'dir must be a non-empty string');
  }
  const dir = path.resolve(opts.dir != null ? opts.dir : DEFAULT_DIR);

  let entries;
  try {
    entries = await fs.promises.readdir(dir, {withFileTypes: true});
  } catch (e) {
    throw new DeviceError('ARGUMENTS_INVALID', `cannot list ${dir}: ${e.code || e.message}`);
  }

  // isFile() on a Dirent is false for a symbolic link, which is the point: a
  // link named x.log is not a log file in this directory.
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith('.log') && e.name !== '.log')
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_FILES);

  const files = [];
  for (const name of names) {
    const stat = await fs.promises.stat(path.join(dir, name));
    files.push({name: name, bytes: stat.size});
  }

  return {output: {dir: dir, files: files}};
};
```

`examples/log-triage/log-read/handlers/readService/read.js`:

```js
// log-read/read: the raw lines of one log file. The only place in the
// log-triage chain where file contents enter the process.
const fs   = require('fs');
const path = require('path');

// examples/log-triage/log-read/handlers/readService/ -> up three.
const DEFAULT_DIR = path.resolve(__dirname, '..', '..', '..', 'sample-logs');

const DEFAULT_MAX_BYTES = 1024 * 1024;

// A bare file name: no separator can appear, so path.join below cannot leave
// the directory. The leading-character rule keeps ".log" and dotfiles out.
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.log$/;

module.exports = async (input) => {
  const opts = input || {};

  if (opts.dir != null && (typeof opts.dir !== 'string' || opts.dir === '')) {
    throw new DeviceError('ARGUMENTS_INVALID', 'dir must be a non-empty string');
  }
  if (typeof opts.name !== 'string' || !NAME_RE.test(opts.name)) {
    throw new DeviceError('ARGUMENTS_INVALID', 'name must be a bare file name ending in .log');
  }

  const maxBytes = (opts.maxBytes != null) ? opts.maxBytes : DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new DeviceError('ARGUMENTS_INVALID', `maxBytes must be a positive integer, got ${JSON.stringify(opts.maxBytes)}`);
  }

  const dir  = path.resolve(opts.dir != null ? opts.dir : DEFAULT_DIR);
  const full = path.join(dir, opts.name);

  // lstat, not stat: a symbolic link named x.log must be refused, not followed.
  let stat;
  try {
    stat = await fs.promises.lstat(full);
  } catch (e) {
    throw new DeviceError('ARGUMENTS_INVALID', `cannot read ${opts.name}: ${e.code || e.message}`);
  }
  if (!stat.isFile()) {
    throw new DeviceError('ARGUMENTS_INVALID', `${opts.name} is not a regular file`);
  }

  let text;
  let truncated = false;

  if (stat.size <= maxBytes) {
    text = await fs.promises.readFile(full, 'utf8');
  } else {
    const handle = await fs.promises.open(full, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const {bytesRead} = await handle.read(buffer, 0, maxBytes, 0);
      text = buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
    // Cut at the last complete line, so no caller ever sees half a line.
    const cut = text.lastIndexOf('\n');
    text = (cut === -1) ? '' : text.slice(0, cut + 1);
    truncated = true;
  }

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1);
  }

  return {output: {name: opts.name, bytes: stat.size, lineCount: lines.length, truncated: truncated, lines: lines}};
};
```

- [ ] **Step 4: Run tests and the validator**

Run: `npx mocha --exit ./test/composition/11-log-triage-units.js`
Expected: `13 passing`

Run: `node bin/countinghouse-validate.js ./examples/log-triage/log-read`
Expected: `ok: log-read -- no problems found`

- [ ] **Step 5: Lint, suite, commit**

```bash
git add examples/log-triage/log-read test/composition/11-log-triage-units.js
git commit -m "examples(log-triage): log-read, the one module that touches the disk"
```

---

### Task 3: `pii-redact` module

**Files:**
- Create: `examples/log-triage/pii-redact/package.json`, `api.json`, `schema.json`, `handlers/redactService/redact.js`
- Test: `test/composition/11-log-triage-units.js` (append)

**Interfaces:**
- Consumes: `gen.PLANTED_PII`, `gen.allPlantedValues`, `gen.generate` (tests only).
- Produces: address `pii-redact/redactService.redact`, input `{lines: string[]}`, output `{lines: string[], counts: {email, ipv4, phone, card, bearerToken}}`. Replacement tags: `<email>`, `<ipv4>`, `<phone>`, `<card>`, `<token>`. Output `lines` has the same length and order as the input.

- [ ] **Step 1: Write the failing tests**

Append to `test/composition/11-log-triage-units.js`:

```js
describe('log-triage units: pii-redact', () => {
  const redact = require(path.join(EXAMPLE, 'pii-redact', 'handlers', 'redactService', 'redact.js'));

  it('replaces each PII type with its tag and counts it', async () => {
    const {output} = await redact({lines: [
      'user login email=alice.nguyen@example.com from 203.0.113.7',
      'sms verification sent to +1-202-555-0143',
      'payment declined for card 4111 1111 1111 1111 order=4821',
      'outbound call header Authorization: Bearer tk_demo_9f8e7d6c5b4a39281706f5e4d3c2b1a0'
    ]});

    assert.deepStrictEqual(output.lines, [
      'user login email=<email> from <ipv4>',
      'sms verification sent to <phone>',
      'payment declined for card <card> order=4821',
      'outbound call header Authorization: <token>'
    ]);
    assert.deepStrictEqual(output.counts, {email: 1, ipv4: 1, phone: 1, card: 1, bearerToken: 1});
  });

  it('leaves a line with no PII untouched, timestamp and numbers included', async () => {
    const line = '2026-09-01T00:00:12.345Z WARN slow query took 8123ms table=orders';
    const {output} = await redact({lines: [line]});

    assert.deepStrictEqual(output.lines, [line]);
    assert.deepStrictEqual(output.counts, {email: 0, ipv4: 0, phone: 0, card: 0, bearerToken: 0});
  });

  it('counts every occurrence on a line', async () => {
    const {output} = await redact({lines: ['from 203.0.113.7 to 203.0.113.42 cc bob.ortiz@example.com']});

    assert.strictEqual(output.lines[0], 'from <ipv4> to <ipv4> cc <email>');
    assert.strictEqual(output.counts.ipv4, 2);
  });

  it('leaves no planted value in a full generated file set, and keeps the line count', async () => {
    const files = gen.generate({dir: path.join(tmpRoot, 'redact'), files: 4, lines: 300, seed: 3});
    const lines = readAll(files).split('\n').slice(0, -1);
    const {output} = await redact({lines: lines});
    const joined = output.lines.join('\n');

    assert.strictEqual(output.lines.length, lines.length);
    for (const value of gen.allPlantedValues()) assert.ok(!joined.includes(value), `leaked ${value}`);
    for (const type of Object.keys(gen.PLANTED_PII)) assert.ok(output.counts[type] > 0, `no ${type} counted`);
  });

  it('rejects input whose lines are not all strings', async () => {
    await assert.rejects(redact({lines: ['ok', 7]}), (err) => err.code === 'ARGUMENTS_INVALID');
    await assert.rejects(redact({}), (err) => err.code === 'ARGUMENTS_INVALID');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha --exit ./test/composition/11-log-triage-units.js`
Expected: FAIL with `Cannot find module '…/pii-redact/handlers/redactService/redact.js'`

- [ ] **Step 3: Write the module**

`examples/log-triage/pii-redact/package.json`:

```json
{
  "name": "pii-redact",
  "version": "1.0.0",
  "description": "DEMO-GRADE regex masking of personal data in supplied log lines -- not a PII scanner. Part of the log-triage composite demo.",
  "dependencies": {},
  "devDependencies": {},
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "author": "mchen6",
  "license": "Apache-2.0"
}
```

`examples/log-triage/pii-redact/api.json`:

```json
{
  "device": {
    "friendlyName": "pii-redact",
    "manufacturer": "countinghouse",
    "modelDescription": "DEMO-GRADE masking of personal data in text lines it is handed. It applies five regular expressions -- e-mail addresses, IPv4 addresses, phone numbers, card-like digit runs and bearer tokens -- and replaces each match with a fixed tag. It is a worked example of a pure-function leaf in the log-triage composite demo, NOT a privacy product: it knows nothing about names, postal addresses, national identifiers or any format outside those five patterns. Do not use it as the redaction step for real logs.",
    "publishAudit": true,
    "iconList": [
      {
        "mimetype": "image/png",
        "width": 88,
        "height": 88,
        "depth": 8,
        "url": "/images/API.png"
      }
    ],
    "serviceList": {
      "urn:countinghouse-com:serviceID:redactService": {
        "actionList": [
          {
            "name": "redact",
            "description": "Masks personal data in the lines you supply and returns the same lines, same order and same count, with every match replaced by a tag: <email>, <ipv4>, <phone>, <card> or <token>. A match is replaced whole, so no character of the matched value survives. Also returns how many matches of each type were replaced. Takes lines as an argument rather than reading disk, which makes it a pure function of its input. IMPORTANT, state this if you report results: matching is regex-only and demo-grade, so a count of zero is not evidence that the text holds no personal data.",
            "input": {
              "schema": "/redactService/redact/input"
            },
            "output": {
              "schema": "/redactService/redact/output"
            },
            "fault": {
              "schema": "/fault/redactService/redact/fault"
            }
          }
        ]
      }
    }
  }
}
```

`examples/log-triage/pii-redact/schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/",
  "type": "object",
  "redactService": {
    "redact": {
      "input": {
        "type": "object",
        "properties": {
          "lines": {
            "title": "lines to mask",
            "description": "Shaped to accept log-read's `lines` array unchanged.",
            "type": "array",
            "items": {"type": "string"}
          }
        },
        "required": ["lines"],
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": {
          "lines": {
            "title": "the same lines with every match replaced by a tag",
            "type": "array",
            "items": {"type": "string"}
          },
          "counts": {
            "title": "matches replaced, per type",
            "type": "object",
            "properties": {
              "email":       {"type": "integer"},
              "ipv4":        {"type": "integer"},
              "phone":       {"type": "integer"},
              "card":        {"type": "integer"},
              "bearerToken": {"type": "integer"}
            },
            "required": ["email", "ipv4", "phone", "card", "bearerToken"],
            "additionalProperties": false
          }
        },
        "required": ["lines", "counts"],
        "additionalProperties": false
      }
    }
  },

  "fault": {
    "redactService": {
      "redact": {
        "fault": {
          "type": "object",
          "properties": {
            "reason": {"title": "specific error reason", "type": "string"},
            "info":   {"title": "detailed error info", "type": "string"}
          }
        }
      }
    }
  }
}
```

`examples/log-triage/pii-redact/handlers/redactService/redact.js`:

```js
// pii-redact: mask personal data in log lines. A pure function of its input --
// no disk, no network, no state -- so the log-triage composite can hand it
// another tool's output without either one touching the filesystem.
//
// DEMO-GRADE. Five regular expressions, nothing else. See the module's
// api.json and the example README for what that does and does not catch.

// Order is load-bearing. The token pattern runs first so the e-mail and digit
// patterns never see inside a token; the card pattern runs before the phone
// pattern because a 16-digit run contains shapes the phone pattern would
// otherwise take a bite out of. A match is replaced whole by its tag: unlike a
// partial mask, a tag cannot leak a prefix or a length.
const PATTERNS = [
  {type: 'bearerToken', tag: '<token>', re: /\bBearer\s+[A-Za-z0-9._~+/_-]{16,}=*/g},
  {type: 'email',       tag: '<email>', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g},
  {type: 'card',        tag: '<card>',  re: /\b(?:\d[ -]?){12,18}\d\b/g},
  {type: 'ipv4',        tag: '<ipv4>',  re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g},
  {type: 'phone',       tag: '<phone>', re: /(?:\+\d{1,3}[-. ]?)?(?:\(\d{3}\)|\d{3})[-. ]\d{3}[-. ]\d{4}\b/g}
];

module.exports = async (input) => {
  const lines = (input != null) ? input.lines : null;

  if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) {
    throw new DeviceError('ARGUMENTS_INVALID', 'lines must be an array of strings');
  }

  const counts = {email: 0, ipv4: 0, phone: 0, card: 0, bearerToken: 0};

  const masked = lines.map((line) => {
    let out = line;
    for (const p of PATTERNS) {
      out = out.replace(p.re, () => { counts[p.type]++; return p.tag; });
    }
    return out;
  });

  return {output: {lines: masked, counts: counts}};
};
```

- [ ] **Step 4: Run tests and the validator**

Run: `npx mocha --exit ./test/composition/11-log-triage-units.js`
Expected: `18 passing`

Run: `node bin/countinghouse-validate.js ./examples/log-triage/pii-redact`
Expected: `ok: pii-redact -- no problems found`

- [ ] **Step 5: Lint, suite, commit**

```bash
git add examples/log-triage/pii-redact test/composition/11-log-triage-units.js
git commit -m "examples(log-triage): pii-redact, demo-grade masking as a pure function"
```

---

### Task 4: `error-cluster` module

**Files:**
- Create: `examples/log-triage/error-cluster/package.json`, `api.json`, `schema.json`, `handlers/clusterService/cluster.js`
- Test: `test/composition/11-log-triage-units.js` (append)

**Interfaces:**
- Produces: address `error-cluster/clusterService.cluster`, input `{lines: string[], topClusters?: integer 1..50}` (default 10), output `{lineCount, unparsed, byLevel: {DEBUG, INFO, WARN, ERROR}, clusterCount, clusters: [{template, level, count, firstSeen, lastSeen, sample}]}`. `clusterCount` is the number of distinct clusters before the `topClusters` cut. `template` and `sample` are at most 160 characters.

- [ ] **Step 1: Write the failing tests**

Append to `test/composition/11-log-triage-units.js`:

```js
describe('log-triage units: error-cluster', () => {
  const cluster = require(path.join(EXAMPLE, 'error-cluster', 'handlers', 'clusterService', 'cluster.js'));

  const LINES = [
    '2026-09-01T00:00:01.000Z INFO request completed in 12ms status=200 path=/api/orders/4821',
    '2026-09-01T00:00:02.000Z ERROR upstream timeout after 3000ms calling inventory-service request=9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0',
    '2026-09-01T00:00:03.000Z WARN slow query took 812ms table=orders',
    '2026-09-01T00:00:04.000Z ERROR upstream timeout after 29999ms calling inventory-service request=00112233-4455-6677-8899-aabbccddeeff',
    '2026-09-01T00:00:05.000Z DEBUG cache hit key=session:deadbeef',
    '    at Worker.run (/srv/app/worker.js:41:17)',
    '',
    '2026-09-01T00:00:06.000Z WARN slow query took 9000ms table=orders',
    '2026-09-01T00:00:07.000Z ERROR upstream timeout after 5ms calling inventory-service request=0a0b0c0d-0e0f-1011-1213-141516171819',
    '2026-09-01T00:00:08.000Z ERROR job 0123456789ab exceeded max attempts, moved to dead letter queue'
  ];

  it('counts levels and unparsed lines', async () => {
    const {output} = await cluster({lines: LINES});

    assert.strictEqual(output.lineCount, 10);
    assert.strictEqual(output.unparsed, 2);
    assert.deepStrictEqual(output.byLevel, {DEBUG: 1, INFO: 1, WARN: 2, ERROR: 4});
  });

  it('merges WARN and ERROR lines that differ only in numbers, hex strings and UUIDs', async () => {
    const {output} = await cluster({lines: LINES});

    assert.strictEqual(output.clusterCount, 3);
    assert.deepStrictEqual(output.clusters, [
      {template: 'upstream timeout after #ms calling inventory-service request=#', level: 'ERROR', count: 3,
       firstSeen: '2026-09-01T00:00:02.000Z', lastSeen: '2026-09-01T00:00:07.000Z',
       sample: 'upstream timeout after 3000ms calling inventory-service request=9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0'},
      {template: 'slow query took #ms table=orders', level: 'WARN', count: 2,
       firstSeen: '2026-09-01T00:00:03.000Z', lastSeen: '2026-09-01T00:00:06.000Z',
       sample: 'slow query took 812ms table=orders'},
      {template: 'job # exceeded max attempts, moved to dead letter queue', level: 'ERROR', count: 1,
       firstSeen: '2026-09-01T00:00:08.000Z', lastSeen: '2026-09-01T00:00:08.000Z',
       sample: 'job 0123456789ab exceeded max attempts, moved to dead letter queue'}
    ]);
  });

  it('breaks count ties by template, so the order is stable', async () => {
    const {output} = await cluster({lines: [
      '2026-09-01T00:00:01.000Z WARN zebra crossed',
      '2026-09-01T00:00:02.000Z WARN apple fell'
    ]});

    assert.deepStrictEqual(output.clusters.map((c) => c.template), ['apple fell', 'zebra crossed']);
  });

  it('keeps only topClusters clusters but still reports how many there were', async () => {
    const {output} = await cluster({lines: LINES, topClusters: 1});

    assert.strictEqual(output.clusters.length, 1);
    assert.strictEqual(output.clusters[0].count, 3);
    assert.strictEqual(output.clusterCount, 3);
  });

  it('caps template and sample at 160 characters', async () => {
    const {output} = await cluster({lines: [`2026-09-01T00:00:01.000Z ERROR ${'x'.repeat(500)}`]});

    assert.strictEqual(output.clusters[0].template.length, 160);
    assert.strictEqual(output.clusters[0].sample.length, 160);
  });

  it('returns zeroes and no clusters for no lines', async () => {
    const {output} = await cluster({lines: []});

    assert.deepStrictEqual(output, {lineCount: 0, unparsed: 0, byLevel: {DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0},
                                    clusterCount: 0, clusters: []});
  });

  it('rejects bad lines and an out-of-range topClusters', async () => {
    const invalid = (err) => err.code === 'ARGUMENTS_INVALID';
    await assert.rejects(cluster({lines: 'nope'}), invalid);
    await assert.rejects(cluster({lines: [], topClusters: 0}), invalid);
    await assert.rejects(cluster({lines: [], topClusters: 51}), invalid);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha --exit ./test/composition/11-log-triage-units.js`
Expected: FAIL with `Cannot find module '…/error-cluster/handlers/clusterService/cluster.js'`

- [ ] **Step 3: Write the module**

`examples/log-triage/error-cluster/package.json`:

```json
{
  "name": "error-cluster",
  "version": "1.0.0",
  "description": "groups WARN and ERROR log lines that differ only in numbers and identifiers. Part of the log-triage composite demo.",
  "dependencies": {},
  "devDependencies": {},
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "author": "mchen6",
  "license": "Apache-2.0"
}
```

`examples/log-triage/error-cluster/api.json`:

```json
{
  "device": {
    "friendlyName": "error-cluster",
    "manufacturer": "countinghouse",
    "modelDescription": "Groups warning and error log lines into clusters of the same message. Lines are expected in the form `<ISO timestamp> <LEVEL> <message>`; two messages fall into one cluster when they are identical after every number, long hex string and UUID is replaced by a placeholder. It is a pure-function leaf in the log-triage composite demo: it reads no files and keeps no state.",
    "publishAudit": true,
    "iconList": [
      {
        "mimetype": "image/png",
        "width": 88,
        "height": 88,
        "depth": 8,
        "url": "/images/API.png"
      }
    ],
    "serviceList": {
      "urn:countinghouse-com:serviceID:clusterService": {
        "actionList": [
          {
            "name": "cluster",
            "description": "Clusters the WARN and ERROR lines among the log lines you supply and returns the largest clusters first: for each, the message template with variable parts shown as #, the level, how many lines matched, the first and last timestamp seen, and one sample message. Also returns a line count per level and how many lines did not parse as `<ISO timestamp> <LEVEL> <message>` -- stack-trace continuation lines and blank lines land there. The sample is copied from the input as-is, so hand this tool lines that have already been masked if they may hold personal data.",
            "input": {
              "schema": "/clusterService/cluster/input"
            },
            "output": {
              "schema": "/clusterService/cluster/output"
            },
            "fault": {
              "schema": "/fault/clusterService/cluster/fault"
            }
          }
        ]
      }
    }
  }
}
```

`examples/log-triage/error-cluster/schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/",
  "type": "object",
  "clusterService": {
    "cluster": {
      "input": {
        "type": "object",
        "properties": {
          "lines": {
            "title": "log lines to cluster",
            "description": "Shaped to accept pii-redact's `lines` array unchanged.",
            "type": "array",
            "items": {"type": "string"}
          },
          "topClusters": {
            "title": "how many clusters to return",
            "description": "Largest first. Defaults to 10.",
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          }
        },
        "required": ["lines"],
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": {
          "lineCount": {"title": "lines received", "type": "integer"},
          "unparsed":  {"title": "lines that are not `<ISO timestamp> <LEVEL> <message>`", "type": "integer"},
          "byLevel": {
            "title": "parsed lines per level",
            "type": "object",
            "properties": {
              "DEBUG": {"type": "integer"},
              "INFO":  {"type": "integer"},
              "WARN":  {"type": "integer"},
              "ERROR": {"type": "integer"}
            },
            "required": ["DEBUG", "INFO", "WARN", "ERROR"],
            "additionalProperties": false
          },
          "clusterCount": {"title": "distinct clusters found, before the topClusters cut", "type": "integer"},
          "clusters": {
            "title": "largest clusters first",
            "type": "array",
            "maxItems": 50,
            "items": {
              "type": "object",
              "properties": {
                "template":  {"title": "message with variable parts shown as #", "type": "string", "maxLength": 160},
                "level":     {"type": "string", "enum": ["WARN", "ERROR"]},
                "count":     {"type": "integer"},
                "firstSeen": {"type": "string", "maxLength": 40},
                "lastSeen":  {"type": "string", "maxLength": 40},
                "sample":    {"title": "one message from the cluster, as supplied", "type": "string", "maxLength": 160}
              },
              "required": ["template", "level", "count", "firstSeen", "lastSeen", "sample"],
              "additionalProperties": false
            }
          }
        },
        "required": ["lineCount", "unparsed", "byLevel", "clusterCount", "clusters"],
        "additionalProperties": false
      }
    }
  },

  "fault": {
    "clusterService": {
      "cluster": {
        "fault": {
          "type": "object",
          "properties": {
            "reason": {"title": "specific error reason", "type": "string"},
            "info":   {"title": "detailed error info", "type": "string"}
          }
        }
      }
    }
  }
}
```

`examples/log-triage/error-cluster/handlers/clusterService/cluster.js`:

```js
// error-cluster: group WARN and ERROR log lines that say the same thing. A
// pure function of its input, like pii-redact.
//
// "The same thing" is deliberately crude: two messages cluster together when
// they are identical once every UUID, every hex string of eight or more
// characters and every run of digits is replaced by '#'. That is enough to
// fold "timeout after 3000ms request=<uuid>" a thousand times into one line of
// a report, which is the job; it is not log-template mining.

const DEFAULT_TOP_CLUSTERS = 10;
const MAX_TOP_CLUSTERS     = 50;
const MAX_TEXT             = 160;

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2}))\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/;

// UUIDs first: left to the other two, one UUID would become five '#'.
const UUID_RE   = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RE    = /\b[0-9a-f]{8,}\b/gi;
const DIGITS_RE = /\d+/g;

module.exports = async (input) => {
  const opts  = input || {};
  const lines = opts.lines;

  if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) {
    throw new DeviceError('ARGUMENTS_INVALID', 'lines must be an array of strings');
  }

  const top = (opts.topClusters != null) ? opts.topClusters : DEFAULT_TOP_CLUSTERS;
  if (!Number.isInteger(top) || top < 1 || top > MAX_TOP_CLUSTERS) {
    throw new DeviceError('ARGUMENTS_INVALID', `topClusters must be an integer from 1 to ${MAX_TOP_CLUSTERS}`);
  }

  const byLevel  = {DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0};
  const clusters = new Map();
  let unparsed = 0;

  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (m == null) { unparsed++; continue; }

    const timestamp = m[1];
    const level     = m[2];
    const message   = m[3];

    byLevel[level]++;
    if (level !== 'WARN' && level !== 'ERROR') continue;

    const template = message.replace(UUID_RE, '#').replace(HEX_RE, '#').replace(DIGITS_RE, '#').slice(0, MAX_TEXT);
    const key      = `${level}|${template}`;
    const existing = clusters.get(key);

    if (existing == null) {
      clusters.set(key, {template: template, level: level, count: 1,
                         firstSeen: timestamp, lastSeen: timestamp,
                         sample: message.slice(0, MAX_TEXT)});
    } else {
      existing.count++;
      // ISO timestamps in one format order the same as strings.
      if (timestamp < existing.firstSeen) existing.firstSeen = timestamp;
      if (timestamp > existing.lastSeen)  existing.lastSeen  = timestamp;
    }
  }

  const sorted = Array.from(clusters.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.template !== b.template) return (a.template < b.template) ? -1 : 1;
    return (a.level < b.level) ? -1 : (a.level > b.level) ? 1 : 0;
  });

  return {output: {
    lineCount:    lines.length,
    unparsed:     unparsed,
    byLevel:      byLevel,
    clusterCount: sorted.length,
    clusters:     sorted.slice(0, top)
  }};
};
```

- [ ] **Step 4: Run tests and the validator**

Run: `npx mocha --exit ./test/composition/11-log-triage-units.js`
Expected: `25 passing`

Run: `node bin/countinghouse-validate.js ./examples/log-triage/error-cluster`
Expected: `ok: error-cluster -- no problems found`

- [ ] **Step 5: Lint, suite, commit**

```bash
git add examples/log-triage/error-cluster test/composition/11-log-triage-units.js
git commit -m "examples(log-triage): error-cluster, grouping lines that differ only in numbers and IDs"
```

---

### Task 5: `log-triage` composite, auth, verification

**Files:**
- Create: `examples/log-triage/log-triage/package.json`, `api.json`, `schema.json`, `handlers/triageService/triage.js`
- Create: `examples/log-triage/auth.json`
- Create: `examples/log-triage/verify-cost-bound.js`
- Test: `test/composition/10-log-triage-example.js`

**Interfaces:**
- Consumes: `log-read/readService.list` → `{dir, files: [{name, bytes}]}`; `log-read/readService.read` (`{dir?, name, maxBytes?}`) → `{name, bytes, lineCount, truncated, lines}`; `pii-redact/redactService.redact` (`{lines}`) → `{lines, counts}`; `error-cluster/clusterService.cluster` (`{lines, topClusters?}`) → `{lineCount, unparsed, byLevel, clusterCount, clusters}`; `generate` and `allPlantedValues` from `generate-logs.js`.
- Produces: tool `log_triage_triageservice_triage`, input `{dir?, maxFiles?, maxBytesPerFile?, topClusters?}`, output `{findings, bill, cost}` as in the spec's Output section.

- [ ] **Step 1: Write the failing end-to-end check**

Create `examples/log-triage/verify-cost-bound.js`:

```js
// The check behind log-triage's headline claim: the bill follows the input,
// and the caller's own cap bounds it.
//
// Runs non-debug and multi-tenant -- under --debug every key resolves to an
// admin session and neither half of the authorize/bill split is observable
// (same reasoning as examples/repo-review/verify-identity-passthrough.js).
// The whole sequence runs twice, once per hop path, because the two paths
// meter in different places (docs/composite-tools.md, "billing authority").
//
// For N files read, the composite makes 2N + 2 inner hops (one list, a read
// and a redact per file, one cluster) and the caller pays 2N + 3 with the
// outer call. The read-then-redact chains run concurrently, so this is also
// the check that concurrent hops are each charged exactly once.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const spawn   = require('child_process').spawn;
const request = require('supertest');

const gen = require('./generate-logs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TRIAGE_DEVICE  = 'dad07d2a-9d65-5ef5-af59-05c0160c5fdc';
const READ_DEVICE    = 'fd0eafbd-20da-53e6-9302-681687350a3b';
const REDACT_DEVICE  = 'b5048beb-2128-52c0-9cd4-42669f57090f';
const CLUSTER_DEVICE = '9f9aab37-b175-5286-81c3-68bdd24bd4f7';

const AS_IDENTITY = 'log-triage-internal';
const TOOL        = 'log_triage_triageservice_triage';
const FILE_COUNT  = 8;

const PATHS = [
  {label: 'main-thread-routed', port: 9596, flags: []},
  {label: 'directPeerChannels', port: 9597, flags: ['--directPeerChannels']}
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startServer(port, authPath, flags) {
  return new Promise((resolve, reject) => {
    const args = [path.join(REPO_ROOT, 'framework.js'),
      '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(port),
      '--authProvider', 'file', '--authConfigPath', authPath, '--mcpToolCallCost', '1',
      '--loadModule', path.join(__dirname, 'log-read'),
      '--loadModule', path.join(__dirname, 'pii-redact'),
      '--loadModule', path.join(__dirname, 'error-cluster'),
      '--loadModule', path.join(__dirname, 'log-triage')].concat(flags);

    const server = spawn(process.execPath, args, {cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.kill('SIGKILL');
      reject(new Error(`server on ${port} never finished discovery:\n${out.slice(-2000)}`));
    }, 60000);

    const onData = (buf) => {
      out += buf.toString();
      // Composition is verified after discovery completes and the verdict is
      // then relayed into the composing module's worker, so "all module
      // discovered" is the earliest useful signal, not the finish line.
      if (!settled && /all module discovered/i.test(out)) {
        settled = true;
        clearTimeout(timer);
        setTimeout(() => resolve(server), 2500);
      }
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);
  });
}

async function balanceOf(url, key) {
  const res = await request(url).get('/balance').set('X-CH-Key', key);
  return (res.body != null) ? res.body.balance : null;
}

// The outer call's own charge is fire-and-forget, so a balance is read only
// once it has stopped moving -- never polled until an expected number shows
// up, which would let an extra charge hide behind an early match.
async function settledBalance(url, key) {
  const deadline = Date.now() + 20000;
  let last = null;
  let stable = 0;

  while (Date.now() < deadline) {
    const balance = await balanceOf(url, key);
    stable = (last !== null && balance === last) ? stable + 1 : 1;
    last   = balance;
    if (stable >= 3) return balance;
    await sleep(200);
  }
  throw new Error(`balance for ${key} never settled (last ${last})`);
}

async function listTools(url, key) {
  const res = await request(url).post('/mcp')
    .set('Content-Type', 'application/json').set('X-CH-Key', key)
    .send({jsonrpc: '2.0', id: 9, method: 'tools/list'});
  return res.body.result.tools.map((t) => t.name);
}

async function triage(url, key, args) {
  const res = await request(url).post('/mcp')
    .set('Content-Type', 'application/json').set('X-CH-Key', key)
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: TOOL, arguments: args}});
  const result = (res.body != null) ? res.body.result : null;

  assert.ok(result != null, `no result: ${JSON.stringify(res.body).slice(0, 800)}`);
  assert.strictEqual(result.isError, false, `call errored: ${JSON.stringify(result).slice(0, 1500)}`);
  return result;
}

// One call, with the caller's and the module identity's balances read before
// and after. Returns what the call returned and what each identity paid.
async function meteredCall(url, caller, args) {
  const callerBefore   = await settledBalance(url, caller);
  const internalBefore = await settledBalance(url, AS_IDENTITY);

  const result = await triage(url, caller, args);

  const callerAfter   = await settledBalance(url, caller);
  const internalAfter = await settledBalance(url, AS_IDENTITY);

  return {
    result:       result,
    out:          result.structuredContent.output,
    callerPaid:   callerBefore - callerAfter,
    internalPaid: internalBefore - internalAfter
  };
}

async function verifyPath(p, dirs) {
  const url      = `http://127.0.0.1:${p.port}`;
  const caller   = `caller-triage-${p.label}-${process.pid}`;
  const authPath = path.join(dirs.root, `auth-${p.label}.json`);

  // The caller is granted the composite device ONLY; the module identity is
  // granted the three inner devices and bound to the module by "runsModules".
  const config = {};
  config[caller]      = {userName: 'caller', devices: [TRIAGE_DEVICE]};
  config[AS_IDENTITY] = {userName: AS_IDENTITY, devices: [READ_DEVICE, REDACT_DEVICE, CLUSTER_DEVICE],
                         runsModules: ['log-triage']};
  fs.writeFileSync(authPath, JSON.stringify(config, null, 2));

  console.log(`\n=== ${p.label} (port ${p.port}) ===`);
  const server = await startServer(p.port, authPath, p.flags);

  try {
    const tools = (await listTools(url, caller)).filter((n) => n !== 'countinghouse_check_balance');
    assert.deepStrictEqual(tools, [TOOL], 'only the composite must be visible to the caller');
    console.log(`[1] tools/list for the caller: ${JSON.stringify(tools)}`);

    // maxFiles 32 is more than the 8 files present: hops must follow the
    // files actually read, not the cap.
    for (const c of [{maxFiles: 1, n: 1}, {maxFiles: 3, n: 3}, {maxFiles: 8, n: 8}, {maxFiles: 32, n: 8}]) {
      const m    = await meteredCall(url, caller, {dir: dirs.logs, maxFiles: c.maxFiles});
      const hops = 2 * c.n + 2;

      assert.strictEqual(m.out.cost.filesRead, c.n);
      assert.strictEqual(m.out.cost.hops, hops, `maxFiles=${c.maxFiles}: expected ${hops} hops`);
      assert.strictEqual(m.out.bill.length, hops);
      assert.strictEqual(m.out.cost.charged, hops);
      assert.strictEqual(m.out.cost.worstCaseHops, 2 * c.maxFiles + 2);
      assert.deepStrictEqual(m.out.bill.map((b) => b.hop), Array.from({length: hops}, (_, i) => i + 1));
      m.out.bill.forEach((b) => {
        assert.strictEqual(b.charged, 1, `hop ${b.hop} must be charged exactly once`);
        assert.strictEqual(b.billedTo, caller, `hop ${b.hop} must be billed to the outer caller`);
        assert.strictEqual(b.authorizedAs, AS_IDENTITY);
      });

      // Concurrent hops each get their own running balance: none repeated.
      const balances = m.out.bill.map((b) => b.balance);
      assert.strictEqual(new Set(balances).size, hops, `per-hop balances repeat: ${JSON.stringify(balances)}`);

      assert.strictEqual(m.out.findings.files.read.length, c.n);
      assert.strictEqual(m.out.findings.files.skipped.length, FILE_COUNT - c.n);
      assert.strictEqual(m.callerPaid, hops + 1, `maxFiles=${c.maxFiles}: caller must pay ${hops + 1}`);
      assert.strictEqual(m.internalPaid, 0, 'the module identity must not be billed');

      // Nothing planted may come back, anywhere in the response.
      const serialized = JSON.stringify(m.result);
      for (const value of gen.allPlantedValues()) {
        assert.ok(!serialized.includes(value), `planted value leaked into the response: ${value}`);
      }
      assert.ok(m.out.findings.pii.total > 0, 'the sample logs hold PII, so some must have been masked');
      assert.ok(m.out.findings.clusters.length > 0);

      console.log(`[2] maxFiles=${String(c.maxFiles).padEnd(2)} files read=${c.n} skipped=${FILE_COUNT - c.n} ` +
                  `hops=${hops} caller paid=${m.callerPaid} module identity paid=${m.internalPaid}`);
    }

    const empty = await meteredCall(url, caller, {dir: dirs.empty});
    assert.strictEqual(empty.out.cost.hops, 1);
    assert.strictEqual(empty.out.bill[0].tool, 'log-read/list');
    assert.deepStrictEqual(empty.out.findings.clusters, []);
    assert.strictEqual(empty.out.findings.pii.total, 0);
    assert.strictEqual(empty.callerPaid, 2);
    assert.strictEqual(empty.internalPaid, 0);
    console.log(`[3] empty directory: hops=1 caller paid=${empty.callerPaid}`);
  } finally {
    server.kill('SIGKILL');
    await sleep(1500);
  }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-triage-verify-'));
  const dirs = {root: root, logs: path.join(root, 'logs'), empty: path.join(root, 'empty')};

  gen.generate({dir: dirs.logs, files: FILE_COUNT, lines: 200, seed: 1});
  fs.mkdirSync(dirs.empty);

  let failed = null;
  try {
    for (const p of PATHS) await verifyPath(p, dirs);
    console.log('\nRESULT: on both hop paths the caller paid 2N + 3 for N files, the cap held, ' +
                'the module identity paid nothing, and no planted value was returned.');
  } catch (e) {
    failed = e;
    console.error('\nFAIL:', e);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
  process.exit(failed == null ? 0 : 1);
})();
```

Create `test/composition/10-log-triage-example.js`:

```js
// examples/log-triage, end to end. The example's own verification script is
// the test: it boots a real non-debug server on each hop path (ports 9596 and
// 9597) and asserts the bill. Run from the suite so the example cannot rot
// silently -- and because it is the only place in the suite where ctx.call
// hops run concurrently against real metering, on both paths.
const assert    = require('assert');
const path      = require('path');
const spawnSync = require('child_process').spawnSync;

describe('composition 10: the log-triage example bills 2N + 3 for N files, on both hop paths', function() {
  this.timeout(240000);

  it('examples/log-triage/verify-cost-bound.js exits 0', () => {
    const script = path.join(__dirname, '..', '..', 'examples', 'log-triage', 'verify-cost-bound.js');
    const run    = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 220000});

    assert.strictEqual(run.status, 0, `verify-cost-bound.js failed:\n${run.stdout}\n${run.stderr}`);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node examples/log-triage/verify-cost-bound.js; echo "exit=$?"`
Expected: `exit=1`, failing in `[1]` or at server start because the `log-triage` module directory does not exist yet. Confirm no `framework.js` process is left: `ps -eo pid,cmd | grep "[f]ramework.js"` prints nothing.

- [ ] **Step 3: Write the composite module and auth file**

`examples/log-triage/log-triage/package.json`:

```json
{
  "name": "log-triage",
  "version": "1.0.0",
  "description": "a composite tool whose bill follows its input: one tools/call lists a log directory, reads and masks each file in-process, clusters the errors, and returns counts and masked samples plus a per-hop bill -- never a raw log line",
  "dependencies": {},
  "devDependencies": {},
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "author": "mchen6",
  "license": "Apache-2.0",
  "countinghouse": {
    "calls": [
      "log-read/readService.list",
      "log-read/readService.read",
      "pii-redact/redactService.redact",
      "error-cluster/clusterService.cluster"
    ]
  }
}
```

`examples/log-triage/log-triage/api.json`:

```json
{
  "device": {
    "friendlyName": "log-triage",
    "manufacturer": "countinghouse",
    "modelDescription": "Triages a directory of application logs by composing three other hosted tools -- log-read, pii-redact and error-cluster -- inside a single tool call. Raw log lines are read, masked and clustered in-process and then discarded: they are never part of this tool's response, and this tool's output schema has no field that could carry one. Unlike a fixed-shape composite, the number of internal hops grows with the number of log files read, each hop is metered to the caller, and the caller caps the total with `maxFiles`.",
    "publishAudit": true,
    "iconList": [
      {
        "mimetype": "image/png",
        "width": 88,
        "height": 88,
        "depth": 8,
        "url": "/images/API.png"
      }
    ],
    "serviceList": {
      "urn:countinghouse-com:serviceID:triageService": {
        "actionList": [
          {
            "name": "triage",
            "description": "Reads the .log files in a directory and returns the largest groups of warnings and errors, with personal data masked. Defaults to the demo's generated sample logs, so it can be called with no arguments once those exist. COST: this tool makes one internal call to list the directory, two per file read (read, then mask) and one to cluster, so reading N files costs 2N + 2 internal calls plus this call itself, all charged to you. `maxFiles` (default 8, maximum 32) caps how many files are read, which fixes the worst case at 2 x maxFiles + 3 before you call; files beyond the cap are not read and are listed as skipped. The response has three parts. `findings` is the report: which files were read and skipped, how many values of each personal-data type were masked, line counts per level, and the top clusters with a masked sample each. `bill` is one metering record per internal call. `cost` restates the total and the cap. TWO SCOPE LIMITS TO PASS ON WHEN REPORTING RESULTS: masking is demo-grade regex matching over five patterns, so a zero count is not evidence the logs hold no personal data; and clustering only groups messages that are identical apart from numbers and identifiers.",
            "input": {
              "schema": "/triageService/triage/input"
            },
            "output": {
              "schema": "/triageService/triage/output"
            },
            "fault": {
              "schema": "/fault/triageService/triage/fault"
            }
          }
        ]
      }
    }
  }
}
```

`examples/log-triage/log-triage/schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "#/",
  "type": "object",
  "triageService": {
    "triage": {
      "input": {
        "type": "object",
        "properties": {
          "dir": {
            "title": "directory of .log files to triage",
            "description": "Defaults to examples/log-triage/sample-logs, which `node examples/log-triage/generate-logs.js` fills. Not recursive.",
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "maxFiles": {
            "title": "cap on files read, and so on the bill",
            "description": "Files are taken in name order. Reading N files costs 2N + 2 internal calls. Defaults to 8.",
            "type": "integer",
            "minimum": 1,
            "maximum": 32
          },
          "maxBytesPerFile": {
            "title": "byte budget per file",
            "description": "Passed through to log-read. Defaults to 1048576.",
            "type": "integer",
            "minimum": 1
          },
          "topClusters": {
            "title": "how many clusters to report",
            "description": "Passed through to error-cluster. Defaults to 10.",
            "type": "integer",
            "minimum": 1,
            "maximum": 50
          }
        },
        "additionalProperties": false
      },
      "output": {
        "type": "object",
        "properties": {
          "findings": {
            "title": "the triage report; contains no raw log line",
            "type": "object",
            "properties": {
              "summary": {"title": "one-paragraph human-readable summary", "type": "string", "maxLength": 1000},
              "files": {
                "type": "object",
                "properties": {
                  "dir": {"title": "the directory that was listed", "type": "string", "maxLength": 4096},
                  "read": {
                    "title": "files that were read",
                    "type": "array",
                    "maxItems": 32,
                    "items": {
                      "type": "object",
                      "properties": {
                        "name":      {"type": "string", "maxLength": 255},
                        "bytes":     {"type": "integer"},
                        "lineCount": {"type": "integer"},
                        "truncated": {"type": "boolean"}
                      },
                      "required": ["name", "bytes", "lineCount", "truncated"],
                      "additionalProperties": false
                    }
                  },
                  "skipped": {
                    "title": "names of files left unread because of maxFiles",
                    "type": "array",
                    "maxItems": 256,
                    "items": {"type": "string", "maxLength": 255}
                  }
                },
                "required": ["dir", "read", "skipped"],
                "additionalProperties": false
              },
              "pii": {
                "title": "values masked, per type",
                "type": "object",
                "properties": {
                  "email":       {"type": "integer"},
                  "ipv4":        {"type": "integer"},
                  "phone":       {"type": "integer"},
                  "card":        {"type": "integer"},
                  "bearerToken": {"type": "integer"},
                  "total":       {"type": "integer"}
                },
                "required": ["email", "ipv4", "phone", "card", "bearerToken", "total"],
                "additionalProperties": false
              },
              "levels": {
                "title": "lines per level across the files read",
                "type": "object",
                "properties": {
                  "DEBUG":    {"type": "integer"},
                  "INFO":     {"type": "integer"},
                  "WARN":     {"type": "integer"},
                  "ERROR":    {"type": "integer"},
                  "unparsed": {"type": "integer"}
                },
                "required": ["DEBUG", "INFO", "WARN", "ERROR", "unparsed"],
                "additionalProperties": false
              },
              "clusters": {
                "title": "largest warning and error clusters first",
                "type": "array",
                "maxItems": 50,
                "items": {
                  "type": "object",
                  "properties": {
                    "template":  {"type": "string", "maxLength": 160},
                    "level":     {"type": "string", "enum": ["WARN", "ERROR"]},
                    "count":     {"type": "integer"},
                    "firstSeen": {"type": "string", "maxLength": 40},
                    "lastSeen":  {"type": "string", "maxLength": 40},
                    "sample":    {"title": "one masked message from the cluster", "type": "string", "maxLength": 160}
                  },
                  "required": ["template", "level", "count", "firstSeen", "lastSeen", "sample"],
                  "additionalProperties": false
                }
              }
            },
            "required": ["summary", "files", "pii", "levels", "clusters"],
            "additionalProperties": false
          },

          "bill": {
            "title": "one metering record per internal hop, charged to the outer caller",
            "description": "Ordered by logical position (list; read then redact per file in name order; cluster), not by completion time. The per-file hops run concurrently, so `balance` is each hop's own running balance and is not monotonic down this list.",
            "type": "array",
            "maxItems": 66,
            "items": {
              "type": "object",
              "properties": {
                "hop":          {"type": "integer"},
                "tool":         {"type": "string", "maxLength": 64},
                "file":         {"title": "the file a read or redact hop was for", "type": ["string", "null"], "maxLength": 255},
                "charged":      {"type": ["number", "null"]},
                "balance":      {"type": ["number", "null"]},
                "billedTo":     {"title": "the identity the platform charged for this hop", "type": ["string", "null"], "maxLength": 128},
                "authorizedAs": {"title": "the identity the hop was authorized as", "type": ["string", "null"], "maxLength": 128}
              },
              "required": ["hop", "tool", "file", "charged", "balance", "billedTo", "authorizedAs"],
              "additionalProperties": false
            }
          },

          "cost": {
            "title": "what this call cost in internal hops, against the cap",
            "type": "object",
            "properties": {
              "filesRead":     {"type": "integer"},
              "hops":          {"title": "internal hops made: 2 x filesRead + 2, or 1 for an empty directory", "type": "integer"},
              "charged":       {"title": "sum of bill[].charged; the outer call is charged separately", "type": "number"},
              "maxFiles":      {"title": "the cap in force for this call", "type": "integer"},
              "worstCaseHops": {"title": "2 x maxFiles + 2", "type": "integer"}
            },
            "required": ["filesRead", "hops", "charged", "maxFiles", "worstCaseHops"],
            "additionalProperties": false
          }
        },
        "required": ["findings", "bill", "cost"],
        "additionalProperties": false
      }
    }
  },

  "fault": {
    "triageService": {
      "triage": {
        "fault": {
          "type": "object",
          "properties": {
            "reason": {"title": "specific error reason", "type": "string"},
            "info":   {"title": "detailed error info", "type": "string"}
          }
        }
      }
    }
  }
}
```

`examples/log-triage/log-triage/handlers/triageService/triage.js`:

```js
// log-triage: one MCP tools/call, 2N + 2 in-process hops for N log files, and
// a response that cannot contain a raw log line.
//
// What this adds over examples/repo-review is the shape of the bill.
// repo-review makes three hops on every call; here the hop count is decided by
// the data -- one list, then a read and a redact per file, then one cluster --
// and the caller bounds it with maxFiles. Every hop is a ctx.call with
// {detail: true}, so each one is AUTHORIZED as this module, BILLED to the real
// outer caller, and returns the platformMetering record the `bill` is built
// from (docs/composite-tools.md).
//
// The per-file chains run concurrently. Within a chain read comes before
// redact; across chains nothing is ordered, which is why the bill is assembled
// by position afterwards rather than appended to as hops finish.

// ctx.call resolves and enforces the runsModules-bound identity itself and
// does not hand it back. This mirrors it only as a label for the bill; it must
// match the auth config's "runsModules" binding for "log-triage".
const AUTHORIZED_AS_LABEL = 'log-triage-internal';

const DEFAULT_MAX_FILES = 8;
const MAX_MAX_FILES     = 32;

const PII_TYPES = ['email', 'ipv4', 'phone', 'card', 'bearerToken'];

module.exports = async (input, ctx) => {
  const opts = input || {};

  const maxFiles = (opts.maxFiles != null) ? opts.maxFiles : DEFAULT_MAX_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_MAX_FILES) {
    throw new DeviceError('ARGUMENTS_INVALID', `maxFiles must be an integer from 1 to ${MAX_MAX_FILES}`);
  }

  // One place that runs a hop, so every hop is billed and recorded the same
  // way. Returns the callee's output together with its bill record; the
  // caller of hop() decides where in the bill that record belongs.
  async function hop(label, file, address, hopInput) {
    let result;
    try {
      result = await ctx.call(address, hopInput, {detail: true});
    } catch (e) {
      throw new DeviceError('DEVICE_ACTION_CALL_FAIL', `${label}${file != null ? ` (${file})` : ''}: ${e.message}`);
    }

    const pm = result.platformMetering;
    return {
      output: result.data.output,
      record: {
        tool:         label,
        file:         file,
        charged:      (pm != null && pm.charged != null) ? pm.charged : null,
        balance:      (pm != null && pm.balance != null) ? pm.balance : null,
        billedTo:     (ctx.caller != null) ? ctx.caller.apiKey : null,
        authorizedAs: AUTHORIZED_AS_LABEL
      }
    };
  }

  // Only pass through what the caller set: the leaf input schemas are
  // additionalProperties:false and their defaults are the zero-config path.
  const dirInput = {};
  if (opts.dir != null) dirInput.dir = opts.dir;

  // --- hop 1: which files exist ------------------------------------------
  const listed  = await hop('log-read/list', null, 'log-read/readService.list', dirInput);
  const all     = listed.output.files;
  const chosen  = all.slice(0, maxFiles);
  const skipped = all.slice(maxFiles).map((f) => f.name);

  // --- per file: read, then redact -- the chains run concurrently ---------
  // Raw lines exist in this worker between the two hops of a chain and are
  // dropped when the chain returns: only the redacted lines are kept.
  const chains = await Promise.all(chosen.map(async (f) => {
    const readInput = Object.assign({name: f.name}, dirInput);
    if (opts.maxBytesPerFile != null) readInput.maxBytes = opts.maxBytesPerFile;

    const read     = await hop('log-read/read', f.name, 'log-read/readService.read', readInput);
    const redacted = await hop('pii-redact/redact', f.name, 'pii-redact/redactService.redact',
                               {lines: read.output.lines});

    return {
      file:    {name: read.output.name, bytes: read.output.bytes,
                lineCount: read.output.lineCount, truncated: read.output.truncated},
      lines:   redacted.output.lines,
      counts:  redacted.output.counts,
      records: [read.record, redacted.record]
    };
  }));

  // --- last hop: cluster everything that was read -------------------------
  // Skipped for an empty directory: there is nothing to cluster, and a hop
  // that cannot change the answer should not be charged for.
  const records = [listed.record];
  for (const c of chains) records.push(c.records[0], c.records[1]);

  let clustered = {lineCount: 0, unparsed: 0, byLevel: {DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0},
                   clusterCount: 0, clusters: []};

  if (chains.length > 0) {
    const clusterInput = {lines: [].concat(...chains.map((c) => c.lines))};
    if (opts.topClusters != null) clusterInput.topClusters = opts.topClusters;

    const cluster = await hop('error-cluster/cluster', null, 'error-cluster/clusterService.cluster', clusterInput);
    clustered = cluster.output;
    records.push(cluster.record);
  }

  // --- aggregate -----------------------------------------------------------
  const bill = records.map((r, i) => Object.assign({hop: i + 1}, r));

  const pii = {total: 0};
  for (const type of PII_TYPES) {
    pii[type] = chains.reduce((sum, c) => sum + c.counts[type], 0);
    pii.total += pii[type];
  }

  const problemLines = clustered.byLevel.WARN + clustered.byLevel.ERROR;
  const summary =
    `Read ${chains.length} of ${all.length} log file(s) under ${listed.output.dir}` +
    `${skipped.length > 0 ? ` (${skipped.length} skipped by maxFiles=${maxFiles})` : ''}: ` +
    `${clustered.lineCount} lines, ${clustered.byLevel.ERROR} ERROR and ${clustered.byLevel.WARN} WARN, ` +
    `${clustered.unparsed} unparsed. ` +
    `${problemLines > 0
        ? `The ${problemLines} warning and error lines fall into ${clustered.clusterCount} cluster(s); the ${clustered.clusters.length} largest are listed. `
        : 'No warning or error lines were found. '}` +
    `Masked ${pii.total} personal-data value(s) before clustering; masking is demo-grade regex matching, ` +
    'so a zero count is not evidence the logs hold none. ' +
    `This call made ${bill.length} internal hop(s) against a worst case of ${2 * maxFiles + 2}.`;

  return {
    output: {
      findings: {
        summary: summary.slice(0, 1000),
        files:   {dir: listed.output.dir, read: chains.map((c) => c.file), skipped: skipped.slice(0, 256)},
        pii:     pii,
        levels:  {DEBUG: clustered.byLevel.DEBUG, INFO: clustered.byLevel.INFO,
                  WARN: clustered.byLevel.WARN, ERROR: clustered.byLevel.ERROR,
                  unparsed: clustered.unparsed},
        clusters: clustered.clusters
      },
      bill: bill,
      cost: {
        filesRead:     chains.length,
        hops:          bill.length,
        charged:       bill.reduce((sum, b) => sum + (b.charged != null ? b.charged : 0), 0),
        maxFiles:      maxFiles,
        worstCaseHops: 2 * maxFiles + 2
      }
    }
  };
};
```

`examples/log-triage/auth.json`:

```json
{
  "demo-key": {
    "userName": "demo",
    "devices": [
      "dad07d2a-9d65-5ef5-af59-05c0160c5fdc"
    ]
  },
  "log-triage-internal": {
    "userName": "log-triage-internal",
    "devices": [
      "fd0eafbd-20da-53e6-9302-681687350a3b",
      "b5048beb-2128-52c0-9cd4-42669f57090f",
      "9f9aab37-b175-5286-81c3-68bdd24bd4f7"
    ],
    "runsModules": ["log-triage"]
  }
}
```

- [ ] **Step 4: Validate, then run the end-to-end check until it passes**

Run: `node bin/countinghouse-validate.js ./examples/log-triage/log-triage`
Expected: `ok: log-triage -- no problems found`

Run: `node -e "const a=require('./lib/call-address');for(const n of ['log-read','pii-redact','error-cluster','log-triage'])console.log(n,a.deviceIDForName(n))"`
Expected: the four IDs in Global Constraints, exactly.

Run: `node examples/log-triage/verify-cost-bound.js; echo "exit=$?"`
Expected: for each of the two paths, `[1]`, four `[2]` lines (`hops=4`, `8`, `18`, `18`; `caller paid=5`, `9`, `19`, `19`; `module identity paid=0`) and `[3] empty directory: hops=1 caller paid=2`; then `RESULT: …` and `exit=0`.

Run: `npx mocha --exit ./test/composition/10-log-triage-example.js ./test/composition/11-log-triage-units.js`
Expected: `26 passing`

- [ ] **Step 5: Lint, suite, commit**

```bash
git add examples/log-triage/log-triage examples/log-triage/auth.json examples/log-triage/verify-cost-bound.js test/composition/10-log-triage-example.js
git commit -m "examples(log-triage): the composite, and a check that its bill is 2N + 3"
```

---

### Task 6: README, npm script, doc links, changelog

**Files:**
- Create: `examples/log-triage/README.md`
- Modify: `package.json` (scripts), `README.md`, `docs/index.md`, `docs/composite-tools.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the output of `node examples/log-triage/verify-cost-bound.js` from Task 5, pasted verbatim.

- [ ] **Step 1: Add the npm script**

In `package.json`, add after the `demo:repo-review` line (add a trailing comma to that line):

```json
    "demo:log-triage": "node ./examples/log-triage/generate-logs.js && node ./framework.js --workerThread --bindAddr 127.0.0.1 --mcpToolCallCost 1 --authConfigPath ./examples/log-triage/auth.json --loadModule ./examples/log-triage/log-read --loadModule ./examples/log-triage/pii-redact --loadModule ./examples/log-triage/error-cluster --loadModule ./examples/log-triage/log-triage"
```

Run: `npm run demo:log-triage` in one shell; in another:

```sh
curl -s -X POST http://127.0.0.1:9527/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "X-CH-Key: demo-key" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"log_triage_triageservice_triage","arguments":{"maxFiles":2}}}'
```

Expected: `"isError":false`, `cost.hops` 6, `findings.files.skipped` with 6 names. Save the `structuredContent.output` of this response for Step 2, then stop the server.

- [ ] **Step 2: Write the example README**

Create `examples/log-triage/README.md` with exactly these sections, in this order. Fenced blocks marked *paste* take real output from this machine and are never hand-edited.

````markdown
# log-triage — a composite tool whose bill follows its input

Four modules. One tool. A directory of logs triaged in a single call, where
the number of metered hops depends on how many files there are — and the
caller decides the most it can cost before making the call.

[`repo-review`](../repo-review/README.md) is the flagship composite: three
hops, every time, on a workload where the intermediate data is large. This is
the other shape. Read that one for the byte arithmetic and the comparison with
code execution; read this one for what a composite's bill looks like when the
data decides it.

## What the demo demonstrates

1. **The bill follows the data, and the caller bounds it.** For `N` log files
   the composite makes `2N + 2` inner hops — one to list the directory, a read
   and a redact per file, one to cluster — and each is metered. With the outer
   call that is `2N + 3` charged to the caller. `maxFiles` (default 8) caps
   `N`, so the worst case, `2 × maxFiles + 3`, is known before the call.
   Files past the cap are not read and are named in the response. Checked on
   both hop paths: see [Verifying the bill](#verifying-the-bill).

2. **Raw log lines stay in the runtime.** Lines are read, masked and clustered
   in-process. The response carries counts and one masked sample per cluster,
   and the output schema has no field that could hold a line: every string is
   `maxLength`-capped at 160 characters or a file name, every array is
   `maxItems`-capped, and `additionalProperties` is `false` throughout.

## The four modules

| Module | Tool name | Role |
|---|---|---|
| [`log-read`](log-read/) | `log_read_readservice_list`, `log_read_readservice_read` | Lists the `*.log` files in one directory; returns one file's raw lines. The only module that touches the disk. |
| [`pii-redact`](pii-redact/) | `pii_redact_redactservice_redact` | Replaces e-mail addresses, IPv4 addresses, phone numbers, card-like digit runs and bearer tokens with tags. Pure function. |
| [`error-cluster`](error-cluster/) | `error_cluster_clusterservice_cluster` | Groups `WARN` and `ERROR` lines that differ only in numbers and identifiers. Pure function. |
| [`log-triage`](log-triage/) | `log_triage_triageservice_triage` | The composite, and the only tool meant to be reachable from outside. |

## Running it

Needs a running Redis.

```sh
npm run demo:log-triage
```

That first writes eight sample log files to `examples/log-triage/sample-logs/`
([`generate-logs.js`](generate-logs.js): seeded, so the files are byte-identical
on every machine, and git-ignored), then starts the server with
[`auth.json`](auth.json). Call it with the demo key:

```sh
curl -s -X POST http://127.0.0.1:9527/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "X-CH-Key: demo-key" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"log_triage_triageservice_triage","arguments":{"maxFiles":2}}}'
```

`demo-key` is a demo credential committed on purpose, usable only against a
server you started yourself on `127.0.0.1`. It is granted the composite and
nothing else; the three inner modules are granted to `log-triage-internal`,
the identity the composite's hops are authorized as.

Every planted value in the sample logs is fake by construction: `example.com`
addresses, the `203.0.113.0/24` documentation range, `555` phone numbers, the
standard test card number.

## Expected output

`maxFiles: 2` over the eight sample files — six hops, six files skipped:

```json
<paste: the structuredContent.output saved in Step 1, pretty-printed>
```

Read `bill` with one thing in mind: it is ordered by position — list, then
read and redact for each file in name order, then cluster — not by when each
hop finished. The per-file chains run concurrently, so `balance` is each hop's
own running balance and does not step down evenly through the list. `cost`
is the part to read for totals.

## Verifying the bill

```sh
node examples/log-triage/verify-cost-bound.js
```

The script starts its own non-`--debug`, multi-tenant server, once on the
default hop path and once with `--directPeerChannels`, and asserts for each:
the caller sees exactly one tool; for `maxFiles` of 1, 3, 8 and 32 over eight
files the hop count is `2N + 2`, every hop is charged once and billed to the
caller, and the caller's balance moved by exactly `2N + 3` while the module
identity's did not move; an empty directory costs one hop; and no planted
value appears anywhere in a response.

Copy-pasted from a real run:

```
<paste: the full stdout of the command above>
```

The suite runs the same script (`test/composition/10-log-triage-example.js`).

## Honest boundaries

**`pii-redact` is demo-grade and is not a PII scanner.** It is five regular
expressions. It knows nothing about names, postal addresses or national
identifiers, and any format outside those five patterns passes through
untouched — into the cluster samples, and so into the response. A zero count
proves nothing. It also over-matches: any run of 13 or more digits is masked
as a card number.

**The cap is the caller's, not the platform's.** `maxFiles` bounds the bill
because the composite honours it. The platform itself applies its balance
check and rate limit at the outer call only, not per hop
([`docs/composite-tools.md`](../../docs/composite-tools.md)), so a caller with
almost no balance can still trigger every hop of one call.

**A failed call is still charged for the hops that ran.** If any hop fails the
whole call fails, with no partial result. Metering has already happened for
the hops that completed, and because the per-file chains are concurrent, hops
in other chains may complete — and be charged — after the first failure.

**Concurrency helps the reads more than the masking.** Each module runs in one
worker thread. The `read` hops overlap because they wait on I/O; the `redact`
hops are CPU-bound work in a single worker and run roughly one after another.

**`log-read` reads the directory it is given.** A file name is confined to
that directory — no path separators, no symbolic links — but `dir` itself is
the caller's choice. A real deployment would restrict it to an allowlist.

**Composition is in-process only**, as for every composite here: the four
modules must be loaded into the same runtime.

## Files

```
examples/log-triage/
├── README.md              this file
├── auth.json              demo-key and the module identity
├── generate-logs.js       seeded sample logs with planted fake PII
├── verify-cost-bound.js   the bill, asserted on both hop paths
├── log-read/              lists and reads log files
├── pii-redact/            masks personal data
├── error-cluster/         groups warnings and errors
└── log-triage/            the composite; the only tool to expose
```
````

Then replace the two `<paste: …>` lines with the real output: the response saved in Step 1 (pretty-print with `python3 -m json.tool`), and the stdout of `node examples/log-triage/verify-cost-bound.js`. Replace the temp directory path in the pasted response's `dir` and `summary` with `/path/to/countinghouse/examples/log-triage/sample-logs` and the pid suffix in the pasted caller key with `…`, as `examples/repo-review/README.md` does; change nothing else.

Run: `grep -n "<paste" examples/log-triage/README.md`
Expected: no output.

- [ ] **Step 3: Link it from the main docs**

`README.md` — after the paragraph that ends `For the mechanism on a toy payload, [`docs/composite-tools.md`](…).`, add:

```markdown

A second worked example, [`examples/log-triage/`](https://github.com/mchen6/countinghouse/blob/master/examples/log-triage/README.md),
shows the other shape: a composite whose metered hop count grows with its
input — two hops per log file — and is capped by the caller. Start it with
`npm run demo:log-triage`.
```

`docs/index.md` — after the paragraph that begins `But the number is only the demonstration.`, add:

```markdown

`examples/log-triage` is the same idea with a bill that moves: it triages a directory of logs with two metered hops per file, run concurrently, and the caller sets the most it can cost before calling.
```

`docs/composite-tools.md` — in the `ctx.call` paragraph, after the sentence ending `` `repo-scan`, `secret-detect` and `dep-audit` this way. ``, add:

```markdown
`examples/log-triage/log-triage` is the example with concurrent hops: it
starts a read-then-redact chain per file with `Promise.all`, and each hop is
still metered once.
```

- [ ] **Step 4: Changelog**

In `CHANGELOG.md`, insert above `## 7.0.0`:

```markdown
## 7.1.0 (unreleased)

### Added

- `examples/log-triage` — a second composite example, whose bill follows its
  input. It triages a directory of logs with one `list` hop, a concurrent
  read-then-redact chain per file and one `cluster` hop: `2N + 2` metered hops
  for `N` files, capped by the caller's `maxFiles`. `npm run demo:log-triage`
  starts it; `examples/log-triage/verify-cost-bound.js` asserts the bill on
  both hop paths, and the suite runs that script.

```

If a `## 7.1.0 (unreleased)` heading already exists (the prerequisite fixes may have added one), add the `### Added` block under it instead of a second heading.

- [ ] **Step 5: Full verification and commit**

Run: `npm run lint` — expected: clean.
Run: `npm test` (the full chain, `test7.js` included) — expected: 0 failing; `test/composition` reports 26 more passing than before this plan.
Run: `git status --short` — expected: only the files this task names; no `sample-logs/` entries (they are git-ignored).

```bash
git add examples/log-triage/README.md package.json README.md docs/index.md docs/composite-tools.md CHANGELOG.md
git commit -m "docs: log-triage, the composite example whose bill follows its input"
```
