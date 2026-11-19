'use strict';
// The HTTP spec and schema routes answer only the caller's listing (the
// reviewer's rulings, 2026-11-19, on #400's follow-up): a module the caller's
// tools/list could not list is refused whole, MODULE_NOT_LISTED. That is a
// module outside the key's grants, an unlisted part, a non-scenario module
// under the single-identity profile, or one hidden while it goes on or off
// (module-visibility, global since M5a). Within a listed module, which
// actions are answered stays the load's verdict (#400), tool or not.
const assert = require('assert');
const {listedFor} = require('../../lib/listing-scope');
const visibility = require('../../lib/module-visibility');
const options = require('../../lib/cli-options');

const SCENARIO = 'aaaaaaaa-0000-5000-8000-000000000001';
const TOOL = 'aaaaaaaa-0000-5000-8000-000000000002';
const PART = 'aaaaaaaa-0000-5000-8000-000000000003';
const device = (name, role) => ({packageInfo: {name, countinghouse: role != null ? {role} : {}}});
const cdif = {deviceManager: {
  deviceMap: {[SCENARIO]: device('scenario-mod', 'scenario'), [TOOL]: device('tool-mod', null), [PART]: device('part-mod', 'part')},
  moduleManager: {unlisted: new Set(['part-mod'])}
}};
const MODULE_OF = {[SCENARIO]: 'scenario-mod', [TOOL]: 'tool-mod', [PART]: 'part-mod'};
// the keys' grants as tool-registry grantedDevices answers them (null: all)
const GRANTS = {all: null, toolOnly: new Set([TOOL]), none: new Set()};
const grantedDevices = (key, cb) => cb(null, Object.hasOwn(GRANTS, key) ? GRANTS[key] : new Set());
const listed = (key, id) => new Promise((resolve, reject) => listedFor(cdif, key, id, (err, ok) => (err ? reject(err) : resolve(ok)), {grantedDevices}));

describe('mcp-contract 38: the spec and schema routes answer only the caller\'s listing (unit)', () => {
  const savedSingle = options.singleIdentity;
  before(() => visibility.configure({moduleOf: (id) => MODULE_OF[id] || null, isGone: () => true, changed: () => {}}));
  afterEach(() => { visibility.show(['scenario-mod', 'tool-mod', 'part-mod']); options.singleIdentity = savedSingle; });
  after(() => visibility.configure({moduleOf: () => null, isGone: () => true, changed: () => {}}));

  it('a listed module the key is granted is answered', async () => {
    assert.strictEqual(await listed('all', TOOL), true);
    assert.strictEqual(await listed('toolOnly', TOOL), true);
  });

  it('a module outside the key\'s grants is refused', async () => {
    assert.strictEqual(await listed('toolOnly', SCENARIO), false);
    assert.strictEqual(await listed('none', TOOL), false);
  });

  it('an unlisted part is refused, whatever the key', async () => {
    assert.strictEqual(await listed('all', PART), false);
  });

  it('under the single-identity profile, only a scenario is listed', async () => {
    options.singleIdentity = true;
    assert.strictEqual(await listed('all', SCENARIO), true);
    assert.strictEqual(await listed('all', TOOL), false);
  });

  it('a module hidden while it goes on or off is refused, for everyone, until it is shown', async () => {
    visibility.hide(['tool-mod']);
    assert.strictEqual(await listed('all', TOOL), false);
    assert.strictEqual(await listed('all', SCENARIO), true, 'only the hidden module');
    visibility.show(['tool-mod']);
    assert.strictEqual(await listed('all', TOOL), true);
  });

  it('a grants lookup that fails is passed on, never taken as granted', async () => {
    const failing = (key, cb) => cb(Object.assign(new Error('provider down'), {code: 'AUTH_PROVIDER_FAILED'}));
    await assert.rejects(new Promise((resolve, reject) => listedFor(cdif, 'all', TOOL, (err, ok) => (err ? reject(err) : resolve(ok)), {grantedDevices: failing})),
      (err) => err.code === 'AUTH_PROVIDER_FAILED');
  });
});

// Q2 (the reviewer, 2026-11-19): the routes follow the modern era, as
// tools/list does for a modern client: a declared, usable output is shown
// whatever its type (the legacy era's tools/list shows only an object one).
describe('mcp-contract 38: the schema route shows a declared output of any type (the modern era)', () => {
  const schemaAnswer = require('../../lib/schema-answer');
  const doc = {$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    s: {a: {input: {type: 'object', properties: {x: {type: 'string'}}}, output: {type: 'string', description: 'a plain string'}}}};
  const spec = {device: {friendlyName: 'legacy-shaped', serviceList: {'urn:x:serviceID:s': {actionList: [
    {name: 'a', description: 'd', input: {schema: '/s/a/input'}, output: {schema: '/s/a/output'}}]}}}};

  it('a string output is answered at its pointer and in the container above it', () => {
    assert.deepStrictEqual(schemaAnswer.answer(doc, spec, ['s', 'a', 'output']).value, {type: 'string', description: 'a plain string'});
    assert.deepStrictEqual(schemaAnswer.answer(doc, spec, []).value.s.a.output, {type: 'string', description: 'a plain string'});
  });
});

