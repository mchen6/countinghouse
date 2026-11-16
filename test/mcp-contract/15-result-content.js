// MCP completeness M6, spec sections 1 and 2: a result's binary values
// placed (lib/mcp/result-content.js). The inline budget is per result, in
// schema order; any media type but image/audio is a resource block, stored
// so its uri can be read; a value past the budget is stored and linked. A
// put that fails removes what the call stored already. Server-free: a fake
// blob store.
const assert = require('assert');
const Ajv = require('ajv/dist/2020').default;
const {plan, store, assemble, idOfUri} = require('../../lib/mcp/result-content');
const {advertisedSchema} = require('../../lib/binary-fields');
const {CountinghouseError} = require('../../lib/countinghouse-error');

const KIB = 1024;
const b64 = (n, fill = 'a') => Buffer.alloc(n, fill).toString('base64');
const bin = (mediaType, extra = {}) => ({type: 'string', contentEncoding: 'base64', contentMediaType: mediaType, ...extra});
const SCHEMA = {type: 'object', properties: {
  shot: bin('image/png', {description: 'the screenshot'}),
  clip: bin('audio/wav'),
  report: bin('application/pdf', {description: 'the report as PDF'}),
  pages: {type: 'array', items: bin('image/jpeg')},
  title: {type: 'string'}
}};
const OWNER = `u_${'A'.repeat(22)}`;
const WHO = {module: 'm', action: 'a', tool: 'm_svc_a'};

function fakeBlobs({failAt = null} = {}) {
  const puts = [];
  const removed = [];
  let n = 0;
  return {
    puts, removed,
    async put(item) {
      n += 1;
      if (failAt != null && n === failAt) throw CountinghouseError.withFields('RESULT_STORE_FULL', {limit: 'resourceQuotaItems'});
      const id = String(n).padStart(43, 'x');
      puts.push({id, ...item});
      return {id, expiresAt: 0};
    },
    async remove(id) { removed.push(id); }
  };
}

describe('mcp-contract 15: a result\'s binary values placed (M6)', () => {
  it('the budget is per result, in schema order: what fits is inlined, the rest linked; 0 links everything', () => {
    const output = {shot: b64(600 * KIB), clip: b64(300 * KIB), report: b64(10), pages: [b64(200 * KIB), b64(10)], title: 't'};
    const e = plan(output, SCHEMA, WHO, {inlineBytes: 1024 * KIB});
    assert.deepStrictEqual(e.map((x) => [x.pointer, x.kind, x.inline, x.store]), [
      ['/shot', 'image', true, false],
      ['/clip', 'audio', true, false],
      ['/report', 'resource', true, true],
      ['/pages/0', 'image', false, true],
      ['/pages/1', 'image', true, false]
    ]);
    assert.ok(plan(output, SCHEMA, WHO, {inlineBytes: 0}).every((x) => !x.inline && x.store), '0 links every value');
    assert.strictEqual(plan({title: 't'}, {type: 'object', properties: {title: {type: 'string'}}}, WHO), null, 'no binary field: nothing to do');
  });

  it('a link is named by its property and described by its field schema; a whole binary output by its tool', () => {
    const e = plan({report: b64(10), pages: [b64(10)]}, SCHEMA, WHO, {inlineBytes: 0});
    assert.deepStrictEqual(e.map((x) => [x.name, x.description]), [['report', 'the report as PDF'], ['pages', null]]);
    const whole = plan(b64(10), bin('application/pdf'), WHO, {inlineBytes: 0});
    assert.strictEqual(whole[0].name, 'm_svc_a');
  });

  it('store: each value to store, as the outer caller\'s in the call\'s session, decoded, its source the field\'s pointer', async () => {
    const blobs = fakeBlobs();
    const output = {report: Buffer.from('%PDF').toString('base64'), shot: b64(10)};
    const e = plan(output, SCHEMA, WHO, {inlineBytes: 1024});
    const uris = await store(e, {blobs, owner: OWNER, session: 's-1', source: {module: 'm', tool: 'm_svc_a'}});
    assert.deepStrictEqual(blobs.puts.map((p) => [p.owner, p.session, p.mimeType, p.bytes.toString(), p.source]),
      [[OWNER, 's-1', 'application/pdf', '%PDF', {module: 'm', tool: 'm_svc_a', field: '/report'}]]);
    await store(e, {blobs, owner: OWNER, source: {}});
    assert.strictEqual(blobs.puts[1].session, null, 'no session: null');
    assert.deepStrictEqual(Object.keys(uris), ['/report']);
    assert.match(uris['/report'], /^countinghouse:\/\/r\/[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(idOfUri(uris['/report']), blobs.puts[0].id);
  });

  it('a put that fails removes what the call stored already, and the error goes on', async () => {
    const blobs = fakeBlobs({failAt: 2});
    const e = plan({report: b64(10), pages: [b64(10), b64(10)]}, SCHEMA, WHO, {inlineBytes: 0});
    await assert.rejects(store(e, {blobs, owner: OWNER}), (err) => err.code === 'RESULT_STORE_FULL');
    assert.deepStrictEqual(blobs.removed, [blobs.puts[0].id]);
  });

  it('no owner: nothing stored', async () => {
    const blobs = fakeBlobs();
    assert.deepStrictEqual(await store(plan({report: b64(10)}, SCHEMA, WHO, {inlineBytes: 0}), {blobs, owner: null}), {});
    assert.deepStrictEqual(blobs.puts, []);
  });

  it('assemble: references in structuredContent, the blocks in schema order, each kind as the spec says', () => {
    const output = {shot: b64(4), report: b64(3), pages: [b64(5)], title: 't'};
    const e = plan(output, SCHEMA, WHO, {inlineBytes: 7});
    const uris = {'/report': 'countinghouse://r/R', '/pages/0': 'countinghouse://r/P'};
    const {structured, blocks} = assemble(output, e, uris);
    assert.deepStrictEqual(blocks, [
      {type: 'image', data: output.shot, mimeType: 'image/png'},
      {type: 'resource', resource: {uri: 'countinghouse://r/R', mimeType: 'application/pdf', blob: output.report}},
      {type: 'resource_link', uri: 'countinghouse://r/P', name: 'pages', mimeType: 'image/jpeg', size: 5}
    ]);
    assert.deepStrictEqual(structured, {
      shot: {mimeType: 'image/png', bytes: 4, block: 1},
      report: {mimeType: 'application/pdf', bytes: 3, block: 2, uri: 'countinghouse://r/R'},
      pages: [{mimeType: 'image/jpeg', bytes: 5, uri: 'countinghouse://r/P'}],
      title: 't'
    });
    assert.strictEqual(output.shot.length > 0 && typeof(output.shot), 'string', 'the module\'s output is not changed');
    const ajv = new Ajv({strict: false});
    assert.ok(ajv.validate(advertisedSchema(SCHEMA), structured), JSON.stringify(ajv.errors));
  });

  it('a value with no uri (nothing could be stored): an image stays inline, a resource stays its base64', () => {
    const output = {shot: b64(4), report: b64(3)};
    const {structured, blocks} = assemble(output, plan(output, SCHEMA, WHO, {inlineBytes: 0}), {});
    assert.deepStrictEqual(blocks, [{type: 'image', data: output.shot, mimeType: 'image/png'}]);
    assert.deepStrictEqual(structured, {shot: {mimeType: 'image/png', bytes: 4, block: 1}, report: output.report});
  });
});
