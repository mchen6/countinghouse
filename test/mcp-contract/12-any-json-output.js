// MCP completeness M20, spec section 14: output schemas of any JSON value.
// 2026-07-28: structuredContent "can be any JSON value ... that conforms to
// the tool's outputSchema". By era:
//   modern: any output schema that resolves is advertised; a result carries
//     the validated output as structuredContent whatever its type; the text
//     block is a string output itself, else its JSON;
//   legacy: unchanged: only an object schema is advertised, a non-object
//     result is text only; a whole binary output is its one block.
// An output may be any JSON value, null included, checked by its schema (an
// input stays an object). No bundled tool's tools/list bytes move
// (mcp-contract 01 is the guard).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {spawn} = require('child_process');
const Ajv2020 = require('ajv/dist/2020');
const {testPort} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');
const PORT = testPort(9581);
const KEY = 'm20-any-json';
const SHAPE = 'mcp_conformance_shapeservice_';
const V = '2026-07-28';
const MODERN = {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}};
const PNG = Buffer.from('png bytes').toString('base64');

function rpc(method, params, {modern}) {
  const body = JSON.stringify({jsonrpc: '2.0', id: 1, method, params: modern ? Object.assign({_meta: MODERN}, params) : params});
  const headers = {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-CH-Key': KEY, 'Content-Length': Buffer.byteLength(body)};
  if (modern) Object.assign(headers, {'MCP-Protocol-Version': V, 'Mcp-Method': method}, params.name != null ? {'Mcp-Name': params.name} : {});
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers}, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`not JSON: ${data.slice(0, 300)}`)); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('mcp-contract 12: output schemas of any JSON value, by era (M20)', function() {
  this.timeout(120000);
  let home;
  let server;
  const tools = {};
  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-m20-'));
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({[KEY]: {userName: 'm20', devices: ['*']}}), {mode: 0o600});
    server = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(PORT),
      '--store', 'local', '--storePath', path.join(home, 'store'), '--authProvider', 'file', '--authConfigPath', path.join(home, 'auth.json'),
      '--moduleDataPath', path.join(home, 'module_data'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'mcp-conformance-module')],
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    server.stdout.on('data', (d) => { out = (out + d).slice(-20000); });
    server.stderr.on('data', (d) => { out = (out + d).slice(-20000); });
    for (let w = 0; !/countinghouse ready/.test(out); w += 100) {
      if (w > 60000 || server.exitCode != null) throw new Error(`not ready: ${out.slice(-800)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const era of ['modern', 'legacy']) {
      const r = await rpc('tools/list', {}, {modern: era === 'modern'});
      tools[era] = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    }
  });
  after(() => {
    if (server != null) server.kill('SIGKILL');
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  const CASES = [
    ['array_out', {type: 'array', items: {type: 'string'}}, ['a', 'b'], '["a","b"]'],
    ['string_out', {type: 'string'}, 'plain', 'plain'],
    ['number_out', {type: 'number'}, 3, '3'],
    ['null_out', {type: 'null'}, null, 'null']
  ];

  for (const [name, schema, value, text] of CASES) {
    it(`${name}: a modern tools/list advertises its schema; a legacy one lists it without`, () => {
      assert.deepStrictEqual(tools.modern[SHAPE + name].outputSchema, schema);
      assert.strictEqual(tools.legacy[SHAPE + name].outputSchema, undefined);
    });

    it(`${name}: a modern call carries the value as structuredContent, the text block ${JSON.stringify(text)}; ajv agrees`, async () => {
      const r = (await rpc('tools/call', {name: SHAPE + name, arguments: {}}, {modern: true})).result;
      assert.strictEqual(r.isError, false, JSON.stringify(r));
      assert.deepStrictEqual(r.structuredContent, value);
      assert.deepStrictEqual(r.content[0], {type: 'text', text});
      const validate = new Ajv2020({strict: false}).compile(tools.modern[SHAPE + name].outputSchema);
      assert.ok(validate(r.structuredContent));
    });

    it(`${name}: a legacy call is text only, as before`, async () => {
      const r = (await rpc('tools/call', {name: SHAPE + name, arguments: {}}, {modern: false})).result;
      assert.strictEqual(r.isError, false, JSON.stringify(r));
      assert.strictEqual(r.structuredContent, undefined);
      // unchanged: with no schema advertised, nothing (null) is one empty text block
      assert.deepStrictEqual(r.content[0], {type: 'text', text: value === null ? '' : text});
    });
  }

  it('images nested under a non-object root: modern advertises the array of references; legacy gets their text, then the blocks', async () => {
    const b = (t) => Buffer.from(t).toString('base64');
    const refs = [{mimeType: 'image/png', bytes: 3, block: 1}, {mimeType: 'image/png', bytes: 4, block: 2}];
    const blocks = [{type: 'image', data: b('one'), mimeType: 'image/png'}, {type: 'image', data: b('two!'), mimeType: 'image/png'}];
    assert.strictEqual(tools.modern[`${SHAPE}images_array_out`].outputSchema.items.type, 'object');
    assert.strictEqual(tools.legacy[`${SHAPE}images_array_out`].outputSchema, undefined);
    const m = (await rpc('tools/call', {name: `${SHAPE}images_array_out`, arguments: {}}, {modern: true})).result;
    assert.deepStrictEqual(m.structuredContent, refs);
    assert.deepStrictEqual(m.content.slice(1, 3), blocks);
    const l = (await rpc('tools/call', {name: `${SHAPE}images_array_out`, arguments: {}}, {modern: false})).result;
    assert.strictEqual(l.structuredContent, undefined);
    assert.deepStrictEqual(l.content.slice(0, 3), [{type: 'text', text: JSON.stringify(refs)}, ...blocks], 'never the base64 in the text');
  });

  it('a whole binary output as a legacy task: tasks/result is its one block, as a call is', async () => {
    const created = await rpc('tools/call', {name: `${SHAPE}binary_whole_out`, arguments: {}, task: {}}, {modern: false});
    const taskId = created.result.task.taskId;
    for (let i = 0; i < 100; i++) {
      const got = await rpc('tasks/get', {taskId}, {modern: false});
      if (got.result && got.result.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const r = (await rpc('tasks/result', {taskId}, {modern: false})).result;
    assert.deepStrictEqual(r.content.filter((c) => c.type !== 'text' || !/receipt|reached the model/.test(c.text)), [{type: 'image', data: PNG, mimeType: 'image/png'}]);
  });

  it('an object schema is advertised alike to both eras', () => {
    assert.deepStrictEqual(tools.modern[`${SHAPE}object_out`].outputSchema, tools.legacy[`${SHAPE}object_out`].outputSchema);
  });

  it('a whole binary output: modern gets the reference schema, the reference and its block; legacy its one block, no text', async () => {
    const advertised = tools.modern[`${SHAPE}binary_whole_out`].outputSchema;
    assert.strictEqual(advertised.type, 'object');
    assert.deepStrictEqual(advertised.required, ['mimeType', 'bytes']);
    assert.strictEqual(tools.legacy[`${SHAPE}binary_whole_out`].outputSchema, undefined);
    const m = (await rpc('tools/call', {name: `${SHAPE}binary_whole_out`, arguments: {}}, {modern: true})).result;
    assert.deepStrictEqual(m.structuredContent, {mimeType: 'image/png', bytes: Buffer.byteLength('png bytes'), block: 1});
    assert.deepStrictEqual(m.content.slice(0, 2), [{type: 'text', text: JSON.stringify(m.structuredContent)}, {type: 'image', data: PNG, mimeType: 'image/png'}]);
    const l = (await rpc('tools/call', {name: `${SHAPE}binary_whole_out`, arguments: {}}, {modern: false})).result;
    assert.strictEqual(l.structuredContent, undefined);
    assert.deepStrictEqual(l.content, [{type: 'image', data: PNG, mimeType: 'image/png'}]);
  });
});
