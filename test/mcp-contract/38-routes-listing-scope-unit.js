'use strict';
// The HTTP spec and schema routes answer only the caller's listing (the
// reviewer's rulings, 2026-11-19, on #400's follow-up): a module the caller's
// tools/list could not list is refused whole, MODULE_NOT_LISTED. That is a
// module outside the key's grants, an unlisted part, a non-scenario module
// under the single-identity profile, or one hidden while it goes on or off
// (module-visibility, global since M5a); outside the key's grants, the routes'
// userAuth refuses it first (USER_HAS_NO_DEVICE, auth 54). Within a listed module, which
// actions are answered stays the load's verdict (#400), tool or not.
const assert = require('assert');
const {listedNow} = require('../../lib/listing-scope');
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
// (a key's grants are the routes' userAuth, USER_HAS_NO_DEVICE: auth 54)
const listed = (key, id) => listedNow(cdif, id);

describe('mcp-contract 38: the spec and schema routes answer only the caller\'s listing (unit)', () => {
  const savedSingle = options.singleIdentity;
  before(() => visibility.configure({moduleOf: (id) => MODULE_OF[id] || null, isGone: () => true, changed: () => {}}));
  afterEach(() => { visibility.show(['scenario-mod', 'tool-mod', 'part-mod']); options.singleIdentity = savedSingle; });
  after(() => visibility.configure({moduleOf: () => null, isGone: () => true, changed: () => {}}));

  it('a listed module is answered', async () => {
    assert.strictEqual(await listed('all', TOOL), true);
    assert.strictEqual(await listed('all', SCENARIO), true);
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

