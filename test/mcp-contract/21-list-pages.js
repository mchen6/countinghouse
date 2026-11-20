'use strict';
// Run with --exit (package.json): requiring the gateway leaves a Redis client
// open.
// MCP completeness M1, spec section 5: tools/list in pages, both eras, over
// a fake interface (two devices, 15 and 8 tools) and two synthetic keys: A
// is granted both devices and is an admin, B only the second. The list's
// order is today's; a page resolves its own tools' schemas only; a cursor is
// a position in the caller's own list, so anything that names none -- a
// forged or malformed cursor, another list's, another caller's position
// that this caller isn't listed, an anchor whose module has gone -- gets the
// same -32602. resources/list and resources/templates/list take a cursor
// too, and name nothing. And --listPageSize is from 10 to 1000.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {testPort, redisUrlFor} = require('../helpers/test-env');

const ROOT = path.resolve(__dirname, '../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-21-'));
const AUTH = path.join(home, 'auth.json');
const KEY_A = `test-a-${'a'.repeat(24)}`;
const KEY_B = `test-b-${'b'.repeat(24)}`;
fs.writeFileSync(AUTH, JSON.stringify({[KEY_A]: {userName: 'a', devices: ['alpha', 'beta'], admin: true}, [KEY_B]: {userName: 'b', devices: ['beta']}}));

const options = require('../../lib/cli-options');
// Set again before this file's tests, with the auth provider routed to this
// file's keys (as mcp-contract 09 does): a folder run (CI, the pre-commit
// hook) requires every file first, and the process's one provider is built
// from whichever file asked first.
const OPTIONS = {redisUrl: redisUrlFor(), authConfigPath: AUTH, listPageSize: 10};
// (set in the describe's before(), the process's put back in its after():
// never at load, which every file of a folder run would see -- B-loadopts)
const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
let keptOptions = null;
require('../../lib/logger').createLogger();
const gateway = require('../../lib/mcp/gateway');
const toolRegistry = require('../../lib/mcp/tool-registry');
const {encodeCursor, decodeCursor} = require('../../lib/mcp/pages');

const SVC = 'urn:x:serviceID:svc';
// each action's schema pointers name its tool, so a lookup says whose it is
function device(name, n) {
  const actionList = Array.from({length: n}, (_, i) => {
    const a = `a${String(i).padStart(2, '0')}`;
    const tool = `${name}_svc_${a}`;
    return {name: a, description: `${a} of ${name}`, input: {schema: `/${tool}/in`}, output: {schema: `/${tool}/out`}};
  });
  return {spec: {device: {friendlyName: name, serviceList: {[SVC]: {actionList}}}}, packageInfo: {name}};
}
const devices = {alpha: device('alpha', 15), beta: device('beta', 8)};
const lookups = [];
const ci = {
  deviceManager: {deviceMap: devices, getAllDeviceSpecs: () => Object.fromEntries(Object.entries(devices).map(([id, d]) => [id, d.spec]))},
  getDeviceSchema(deviceID, p, session) { lookups.push(p); session.localCallback(null, {type: 'object', properties: {}}); },
  rateLimit: (key, cb) => cb(null, {limited: false})
};

const MODERN = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const ask = (method, key, cursor, {modern = false} = {}) => new Promise((resolve) => {
  const params = {};
  if (cursor !== undefined) params.cursor = cursor;
  if (modern) params._meta = MODERN;
  gateway.handle({jsonrpc: '2.0', id: 1, method, params}, ci, key, (err, r) => resolve(r));
});
const list = (key, cursor, opts) => ask('tools/list', key, cursor, opts);
async function pagesOf(key, opts) {
  const pages = [];
  let cursor;
  do {
    const r = await list(key, cursor, opts);
    assert.ok(r.result != null, JSON.stringify(r));
    pages.push(r.result);
    cursor = r.result.nextCursor;
  } while (cursor !== undefined && pages.length < 50);
  return pages;
}
async function withSize(n, fn) {
  const was = options.listPageSize;
  options.listPageSize = n;
  try { return await fn(); } finally { options.listPageSize = was; }
}
const whole = (key, opts) => withSize(1000, async () => {
  const r = await list(key, undefined, opts);
  assert.ok(r.result != null && !('nextCursor' in r.result), JSON.stringify(r).slice(0, 500));
  return r.result.tools;
});
const names = (tools) => tools.map((t) => t.name);
const PLATFORM = names(toolRegistry.platformTools());

describe('mcp-contract 21: tools/list in pages (M1)', function() {
  this.timeout(30000);
  let provider = null;
  let real = null;
  before(() => {
    keptOptions = optionsNow();
    options.setOptions(OPTIONS);
    const FileAuthProvider = require('../../lib/auth/file-provider');
    const own = new FileAuthProvider({configPath: AUTH});
    provider = require('../../lib/auth').getAuthProvider();
    real = {authenticate: provider.authenticate, listDevices: provider.listDevices};
    provider.authenticate = (...args) => own.authenticate(...args);
    provider.listDevices = (...args) => own.listDevices(...args);
  });
  after(() => {
    if (provider != null) Object.assign(provider, real);
    fs.rmSync(home, {recursive: true, force: true});
    restoreOptions(keptOptions);
  });
  afterEach(() => { options.authoringTools = false; });

  for (const modern of [false, true]) {
    const era = modern ? '2026-07-28' : 'legacy';
    it(`${era}: pages of 10, put together, are the whole list in today's order; only the last has no nextCursor`, async () => {
      const all = await whole(KEY_A, {modern});
      assert.deepStrictEqual(names(all), PLATFORM.concat(Object.keys(toolRegistry.buildToolTargets(ci))), 'today\'s order');
      assert.strictEqual(all.length, PLATFORM.length + 23);
      const pages = await pagesOf(KEY_A, {modern});
      assert.strictEqual(pages.length, Math.ceil(all.length / 10));
      pages.forEach((p, i) => {
        assert.ok(p.tools.length <= 10);
        if (i < pages.length - 1) assert.strictEqual(typeof p.nextCursor, 'string', `page ${i}`);
        else assert.ok(!('nextCursor' in p), 'the last page has no nextCursor');
        if (modern) assert.deepStrictEqual([p.ttlMs, p.cacheScope], [0, 'private'], 'every page keeps the caching hints');
      });
      assert.deepStrictEqual(pages.flatMap((p) => p.tools), all);
    });
  }

  it('a list that fits one page has no nextCursor', async () => {
    const r = await withSize(250, () => list(KEY_A));
    assert.ok(r.result != null && !('nextCursor' in r.result));
    assert.strictEqual(r.result.tools.length, PLATFORM.length + 23);
  });

  it('a page resolves the schemas of its own tools only', async () => {
    const first = await list(KEY_A);
    lookups.length = 0;
    const second = await list(KEY_A, first.result.nextCursor);
    const own = names(second.result.tools).filter((n) => !PLATFORM.includes(n));
    assert.strictEqual(own.length, 10);
    assert.deepStrictEqual(lookups.slice().sort(), own.flatMap((n) => [`/${n}/in`, `/${n}/out`]).sort());
  });

  it('every cursor that names no position in the caller\'s list gets the same -32602', async () => {
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const bad = ['x', '', 42, {}, 'A'.repeat(600), encodeCursor('resources', 'alpha_svc_a00'), encodeCursor('tools', 'never_listed'),
      b64({v: 1, k: 'tools', a: 'alpha_svc_a00', o: 5}), b64({v: 2, k: 'tools', a: 'alpha_svc_a00'})];
    const answers = [];
    for (const c of bad) {
      const r = await list(KEY_A, c);
      assert.ok(r.result == null && r.error != null, `${JSON.stringify(c)}: ${JSON.stringify(r).slice(0, 300)}`);
      assert.strictEqual(r.error.code, -32602);
      answers.push(JSON.stringify(r.error));
    }
    assert.strictEqual(new Set(answers).size, 1, `one answer for all: ${[...new Set(answers)].join(' / ')}`);
  });

  it('another caller\'s cursor positions within this caller\'s own list, or is -32602; never an item it isn\'t listed', async () => {
    options.authoringTools = true;
    const mine = names(await whole(KEY_B));
    const theirs = (await pagesOf(KEY_A)).map((p) => p.nextCursor).filter((c) => c !== undefined);
    theirs.push(encodeCursor('tools', PLATFORM[PLATFORM.length - 1]));
    let positioned = 0;
    let refused = 0;
    for (const c of theirs) {
      const r = await list(KEY_B, c);
      if (r.error != null) { assert.strictEqual(r.error.code, -32602); refused += 1; continue; }
      positioned += 1;
      const anchor = decodeCursor('tools', c);
      assert.ok(mine.includes(anchor), `positioned at ${anchor}, which B isn't listed`);
      for (const n of names(r.result.tools)) assert.ok(mine.includes(n), `B was shown ${n}`);
      assert.deepStrictEqual(names(r.result.tools), mine.slice(mine.indexOf(anchor) + 1, mine.indexOf(anchor) + 11));
    }
    assert.ok(positioned > 0 && refused > 0, `positioned ${positioned}, refused ${refused}`);
  });

  it('an anchor whose module went between pages gets -32602; the list from the start is served', async () => {
    const first = await list(KEY_A);
    assert.match(decodeCursor('tools', first.result.nextCursor), /^alpha_/);
    const alpha = devices.alpha;
    delete devices.alpha;
    try {
      const r = await list(KEY_A, first.result.nextCursor);
      assert.strictEqual(r.error && r.error.code, -32602, JSON.stringify(r).slice(0, 300));
      const again = await list(KEY_A);
      assert.ok(again.result != null && !names(again.result.tools).some((n) => n.startsWith('alpha_')));
    } finally {
      devices.alpha = alpha;
    }
  });

  it('for an admin, the authoring tools come after the device tools, paged like them; another caller has none', async () => {
    options.authoringTools = true;
    const a = (await pagesOf(KEY_A)).flatMap((p) => names(p.tools));
    const authoring = names(toolRegistry.AUTHORING_TOOLS);
    assert.deepStrictEqual(a.slice(-authoring.length), authoring);
    assert.deepStrictEqual(a, names(await whole(KEY_A)));
    const b = (await pagesOf(KEY_B)).flatMap((p) => names(p.tools));
    assert.ok(!b.some((n) => authoring.includes(n)));
  });

  for (const method of ['resources/list', 'resources/templates/list']) {
    it(`${method}: no cursor lists nothing, as before; any cursor is -32602`, async () => {
      const r = await ask(method, KEY_A);
      assert.ok(r.result != null, JSON.stringify(r));
      assert.ok(!('nextCursor' in r.result));
      for (const c of [encodeCursor(method === 'resources/list' ? 'resources' : 'resourceTemplates', 'x'), 'x']) {
        const bad = await ask(method, KEY_A, c);
        assert.strictEqual(bad.error && bad.error.code, -32602, JSON.stringify(bad));
      }
    });
  }

  describe('--listPageSize', () => {
    const start = (args) => spawnSync(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(testPort(9592))].concat(args),
      {cwd: ROOT, encoding: 'utf8', timeout: 20000});
    const optionsOf = (argv) => {
      const script = `const o = require(${JSON.stringify(path.join(ROOT, 'lib', 'cli-options'))}); o.setOptions(${JSON.stringify(argv)});
        process.stdout.write(JSON.stringify({size: o.listPageSize, bad: o.listPageSizeInvalid}));`;
      const run = spawnSync(process.execPath, ['-e', script], {cwd: ROOT, encoding: 'utf8', timeout: 20000});
      assert.strictEqual(run.status, 0, run.stderr);
      return JSON.parse(run.stdout);
    };
    it('is 250 by default; 10 and 1000 are taken', () => {
      assert.deepStrictEqual(optionsOf({}), {size: 250, bad: null});
      assert.deepStrictEqual(optionsOf({listPageSize: 10}), {size: 10, bad: null});
      assert.deepStrictEqual(optionsOf({listPageSize: 1000}), {size: 1000, bad: null});
    });
    for (const v of ['9', '1001', '1.5', 'many', '0']) {
      it(`--listPageSize ${v} exits 2, naming it`, () => {
        const r = start(['--listPageSize', v]);
        assert.strictEqual(r.status, 2, r.stderr);
        assert.match(r.stderr, /--listPageSize must be a whole number from 10 to 1000/);
      });
    }
  });
});
