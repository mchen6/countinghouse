'use strict';
// Run with --exit (package.json): requiring the gateway leaves a Redis client
// open.
// MCP completeness M2, spec section 4: a tool's title, annotations and icons
// on tools/list, each only when its action declares it, after the keys a
// tool always had (name, description, inputSchema, outputSchema), so no
// existing tool's bytes move. An icon is inlined as a data: URI from what
// the load read and checked (lib/declared-icons.js inline), never from a
// file read at list time and never as a URL. A page ends before the tool
// that would take it past 4 MiB of JSON, with one tool at least.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {redisUrlFor} = require('../helpers/test-env');

const options = require('../../lib/cli-options');
const OPTIONS = {redisUrl: redisUrlFor(), debug: true, listPageSize: 250};
// (set in the describe's before(), the process's put back in its after():
// never at load, which every file of a folder run would see -- B-loadopts)
const {snapshot: optionsNow, restore: restoreOptions} = require('../helpers/options-scope');
let keptOptions = null;
require('../../lib/logger').createLogger();
const gateway = require('../../lib/mcp/gateway');
const icons = require('../../lib/declared-icons');
const pages = require('../../lib/mcp/pages');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'declares-everything');
const PNG = fs.readFileSync(path.join(FIXTURE, 'icons', 'note.png'));
const SVC = 'urn:x:serviceID:svc';
const MODERN = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};

// a fake interface: one device whose actions are given, its icons as the
// load would have kept them (a worker's spec record, wm.moduleSpec.icons)
function fakeInterface(actions, kept, {schema = {type: 'object', properties: {}}} = {}) {
  const spec = {device: {friendlyName: 'meta', serviceList: {[SVC]: {actionList: actions}}}};
  const devices = {meta: {spec, packageInfo: {name: 'meta'}, moduleSpec: {icons: kept}}};
  return {
    deviceManager: {deviceMap: devices, getAllDeviceSpecs: () => ({meta: spec})},
    getDeviceSchema(deviceID, p, session) { session.localCallback(null, schema); },
    rateLimit: (key, cb) => cb(null, {limited: false})
  };
}
const list = (ci, {modern = false, cursor} = {}) => new Promise((resolve) => {
  const params = {};
  if (modern) params._meta = MODERN;
  if (cursor !== undefined) params.cursor = cursor;
  gateway.handle({jsonrpc: '2.0', id: 1, method: 'tools/list', params}, ci, 'k', (err, r) => resolve(r));
});
const moduleTools = (r) => r.result.tools.filter((t) => t.name.startsWith('meta_'));
const action = (name, extra = {}) => Object.assign({name, description: `${name} it`, input: {schema: `/${name}/in`}, output: {schema: `/${name}/out`}}, extra);

describe('mcp-contract 22: tool metadata on tools/list (M2)', function() {
  this.timeout(30000);
  before(() => { keptOptions = optionsNow(); options.setOptions(OPTIONS); });
  after(() => { restoreOptions(keptOptions); });

  describe('the icons a load keeps (declared-icons inline)', () => {
    it('reads each declared file once, as {mimeType, data, src}', () => {
      const spec = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'api.json'), 'utf8'));
      const got = icons.inline(FIXTURE, spec);
      assert.strictEqual(got.problem, undefined, got.problem);
      assert.deepStrictEqual([...got.icons.keys()], ['icons/note.png']);
      assert.deepStrictEqual(got.icons.get('icons/note.png'), {mimeType: 'image/png', data: PNG.toString('base64'), src: `data:image/png;base64,${PNG.toString('base64')}`});
    });

    it('a file that is missing, an SVG, too large or outside the module is the load\'s refusal, naming it', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-22-'));
      try {
        fs.mkdirSync(path.join(dir, 'icons'));
        fs.writeFileSync(path.join(dir, 'icons', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
        fs.writeFileSync(path.join(dir, 'icons', 'big.png'), Buffer.concat([PNG, Buffer.alloc(icons.MAX_ICON_BYTES)]));
        fs.symlinkSync(path.join(FIXTURE, 'icons', 'note.png'), path.join(dir, 'icons', 'out.png'));
        const spec = (file) => ({device: {friendlyName: 'x', serviceList: {[SVC]: {actionList: [action('go', {icons: [{file}]})]}}}});
        for (const [file, why] of [['icons/none.png', /does not exist/], ['icons/a.svg', /SVG is refused/], ['icons/big.png', /at most 16384/], ['icons/out.png', /outside the module/]]) {
          const got = icons.inline(dir, spec(file));
          assert.strictEqual(got.icons, undefined, file);
          assert.match(got.problem, new RegExp(file.replace('.', '\\.')));
          assert.match(got.problem, why);
        }
        assert.deepStrictEqual(icons.inline(dir, {device: {friendlyName: 'x', serviceList: {[SVC]: {actionList: [action('go')]}}}}), {icons: new Map()});
        // the review of M2: the bound is on files read, not on entries; one
        // file named by many actions is read once and loads
        fs.copyFileSync(path.join(FIXTURE, 'icons', 'note.png'), path.join(dir, 'icons', 'one.png'));
        const many = {device: {friendlyName: 'x', serviceList: {[SVC]: {actionList: Array.from({length: 70}, (_, i) => action(`a${i}`, {icons: [{file: 'icons/one.png'}, {file: 'icons/one.png'}, {file: 'icons/one.png'}, {file: 'icons/one.png'}]}))}}}};
        const got = icons.inline(dir, many);
        assert.strictEqual(got.problem, undefined, got.problem);
        assert.deepStrictEqual([...got.icons.keys()], ['icons/one.png']);
      } finally {
        fs.rmSync(dir, {recursive: true, force: true});
      }
    });
  });

  for (const modern of [false, true]) {
    const era = modern ? '2026-07-28' : 'legacy';
    it(`${era}: title, annotations and icons appear only when declared, after the keys a tool always had`, async () => {
      const kept = new Map([['icons/note.png', {mimeType: 'image/png', data: PNG.toString('base64')}]]);
      const ci = fakeInterface([
        action('plain'),
        action('all', {title: 'All of it', annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
          icons: [{file: 'icons/note.png', sizes: ['1x1']}, {file: 'icons/note.png'}]}),
        action('some', {annotations: {destructiveHint: true}}),
        action('none', {annotations: {}})
      ], kept);
      const [plain, all, some, none] = moduleTools(await list(ci, {modern}));
      assert.deepStrictEqual(Object.keys(none), ['name', 'description', 'inputSchema', 'outputSchema'], 'no hint declared: no annotations');
      assert.deepStrictEqual(Object.keys(plain), ['name', 'description', 'inputSchema', 'outputSchema']);
      assert.deepStrictEqual(Object.keys(all), ['name', 'description', 'inputSchema', 'outputSchema', 'title', 'annotations', 'icons']);
      assert.strictEqual(all.title, 'All of it');
      assert.deepStrictEqual(all.annotations, {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false});
      assert.deepStrictEqual(all.icons, [
        {src: `data:image/png;base64,${PNG.toString('base64')}`, mimeType: 'image/png', sizes: ['1x1']},
        {src: `data:image/png;base64,${PNG.toString('base64')}`, mimeType: 'image/png'}
      ]);
      assert.deepStrictEqual(Object.keys(some), ['name', 'description', 'inputSchema', 'outputSchema', 'annotations']);
    });
  }

  it('an icon the load did not keep is left out, never read at list time', async () => {
    const ci = fakeInterface([action('all', {icons: [{file: 'icons/note.png'}]})], new Map());
    const [tool] = moduleTools(await list(ci));
    assert.ok(!('icons' in tool), JSON.stringify(tool).slice(0, 300));
  });

  it('a page ends before the tool that would take it past 4 MiB of JSON; the pages put together are the whole list', async () => {
    assert.strictEqual(pages.MAX_PAGE_BYTES, 4 * 1024 * 1024);
    // four icons of 16 KiB each: about 87 KB of JSON a tool, so 60 tools
    // are more than one page's bytes though fewer than its 250 items
    const data = Buffer.alloc(16 * 1024, 7).toString('base64');
    const kept = new Map([0, 1, 2, 3].map((i) => [`icons/${i}.png`, {mimeType: 'image/png', data}]));
    const ci = fakeInterface(Array.from({length: 60}, (_, i) => action(`t${String(i).padStart(2, '0')}`, {icons: [0, 1, 2, 3].map((n) => ({file: `icons/${n}.png`}))})), kept);
    const got = [];
    let cursor;
    let count = 0;
    do {
      const r = await list(ci, {cursor});
      assert.ok(r.result != null, JSON.stringify(r).slice(0, 300));
      assert.ok(Buffer.byteLength(JSON.stringify(r)) <= pages.MAX_PAGE_BYTES, `page ${count}: the whole answer, envelope and cursor too`);
      got.push(...r.result.tools);
      cursor = r.result.nextCursor;
      count += 1;
    } while (cursor !== undefined && count < 10);
    assert.ok(count >= 2, `cut by bytes: ${count} page(s)`);
    const whole = await new Promise((resolve) => gateway.handle({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}, ci, 'k', (err, r) => resolve(r), {wholeList: true}));
    assert.deepStrictEqual(got.map((t) => t.name), whole.result.tools.map((t) => t.name));
  });

  it('a tool larger than a page\'s bytes is a page of its own', async () => {
    const huge = {type: 'object', properties: {x: {type: 'string', description: 'y'.repeat(5 * 1024 * 1024)}}};
    const ci = fakeInterface([action('a'), action('b')], new Map(), {schema: huge});
    const seen = [];
    let cursor;
    for (let n = 0; n < 10; n++) {
      const r = await list(ci, {cursor});
      const names = r.result.tools.map((t) => t.name);
      if (names.some((x) => x.startsWith('meta_'))) assert.strictEqual(names.length, 1, `a huge tool is a page of its own: ${names.join(', ')}`);
      seen.push(...names);
      cursor = r.result.nextCursor;
      if (cursor === undefined) break;
    }
    assert.deepStrictEqual(seen.filter((x) => x.startsWith('meta_')), ['meta_svc_a', 'meta_svc_b'], 'nothing lost or repeated');
  });
});
