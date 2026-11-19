'use strict';
// The HTTP routes that show a module answer only the caller's listing (the
// reviewer's rulings, 2026-11-19, on #400's follow-up, and #447's high
// review): a module the caller's tools/list could not show is refused whole,
// MODULE_NOT_LISTED. That is an unlisted part, a non-scenario module under
// the single-identity profile, or one hidden while it goes on or off
// (module-visibility, global since M5a); outside the key's grants, the
// routes' userAuth refuses it first (USER_HAS_NO_DEVICE, auth 54). A device
// no module serves is "missing", whatever the profile: the route goes on to
// its own answer, DEVICE_NOT_FOUND. Within a listed module, which actions
// are answered stays the load's verdict (#400), tool or not.
const assert = require('assert');
const {scopeOf} = require('../../lib/listing-scope');
const visibility = require('../../lib/module-visibility');
const options = require('../../lib/cli-options');

const SCENARIO = 'aaaaaaaa-0000-5000-8000-000000000001';
const TOOL = 'aaaaaaaa-0000-5000-8000-000000000002';
const PART = 'aaaaaaaa-0000-5000-8000-000000000003';
const RESTARTING = 'aaaaaaaa-0000-5000-8000-000000000004';
const NOWHERE = 'aaaaaaaa-0000-5000-8000-000000000005';
const STALE = 'aaaaaaaa-0000-5000-8000-000000000006';
const device = (name, role) => ({packageInfo: {name, countinghouse: role != null ? {role} : {}}});
const MODULE_OF = {[SCENARIO]: 'scenario-mod', [TOOL]: 'tool-mod', [PART]: 'part-mod', [RESTARTING]: 'down-part'};
const PACKAGES = {'down-part': {name: 'down-part', countinghouse: {role: 'part'}}};
const cdif = {deviceManager: {
  deviceMap: {[SCENARIO]: device('scenario-mod', 'scenario'), [TOOL]: device('tool-mod', null), [PART]: device('part-mod', 'part')},
  // a part that is restarting: no device in the map, its ended state kept;
  // an uninstalled module's device: an owner remembered, nothing held
  moduleOfDevice: (id) => (id === RESTARTING ? 'down-part' : id === STALE ? 'uninstalled-mod' : null),
  packageOfModule: (name) => PACKAGES[name] || null,
  moduleManager: {unlisted: new Set(['part-mod', 'down-part']), modules: {},
    endedStateForDevice: (id) => (id === RESTARTING ? {name: 'down-part'} : null)}
}};

describe('mcp-contract 38: the routes that show a module answer only the caller\'s listing (unit)', () => {
  const savedSingle = options.singleIdentity;
  let savedDeps = null;
  before(() => { savedDeps = visibility.configure({moduleOf: (id) => MODULE_OF[id] || null, isGone: () => true, changed: () => {}}); });
  afterEach(() => { visibility.show(Object.values(MODULE_OF)); options.singleIdentity = savedSingle; });
  after(() => { visibility.configure(savedDeps); });

  it('a listed module is answered', () => {
    assert.strictEqual(scopeOf(cdif, TOOL), 'listed');
    assert.strictEqual(scopeOf(cdif, SCENARIO), 'listed');
  });

  it('an unlisted part is refused, a restarting one too', () => {
    assert.strictEqual(scopeOf(cdif, PART), 'unlisted');
    assert.strictEqual(scopeOf(cdif, RESTARTING), 'unlisted');
  });

  it('under the single-identity profile, only a scenario is listed; a device no module serves is missing, not refused', () => {
    options.singleIdentity = true;
    assert.strictEqual(scopeOf(cdif, SCENARIO), 'listed');
    assert.strictEqual(scopeOf(cdif, TOOL), 'unlisted');
    assert.strictEqual(scopeOf(cdif, NOWHERE), 'missing');
  });

  it('a device whose module is gone is missing, an object\'s own key no device', () => {
    options.singleIdentity = true;
    assert.strictEqual(scopeOf(cdif, STALE), 'missing', 'an owner only remembered holds nothing');
    assert.strictEqual(scopeOf(cdif, 'constructor'), 'missing');
    assert.strictEqual(scopeOf(cdif, '__proto__'), 'missing');
  });

  it('a module hidden while it goes on or off is refused, for everyone, until it is shown', () => {
    visibility.hide(['tool-mod']);
    assert.strictEqual(scopeOf(cdif, TOOL), 'unlisted');
    assert.strictEqual(scopeOf(cdif, SCENARIO), 'listed', 'only the hidden module');
    visibility.show(['tool-mod']);
    assert.strictEqual(scopeOf(cdif, TOOL), 'listed');
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
