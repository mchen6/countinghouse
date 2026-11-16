'use strict';
// MCP completeness M0 (docs/superpowers/specs/2026-11-15-mcp-completeness-design.md,
// "The layer at a glance" and sections 1, 3, 4, 7, 8, 9): everything new a
// module can declare, checked before anything serves it. Server-free.
//
// The meta-schema (spec/schema.json) holds each field's shape and bounds,
// with the action object still closed. lib/declarations.js holds what a
// schema cannot say: where a binary field may sit, that a resource's
// variables are the action's string inputs, that a prompt's arguments are
// strings, that a question's schema is a flat form, that x-mcp-header is
// nowhere in an input schema. countinghouse-validate reports them all; the
// load makes the same checks, and is the one that decides.
const assert = require('assert');

require('../../lib/cli-options').setOptions({workerThread: false});
const validator = require('../../lib/validator');

const SERVICE = 'urn:countinghouse-test:serviceID:notesService';
// a spec with one action, `over` laid over it, and the device's own extras
const specOf = (action = {}, device = {}) => ({device: Object.assign({
  friendlyName: 'notes', manufacturer: 'countinghouse-test', modelDescription: 'notes',
  serviceList: {[SERVICE]: {actionList: [Object.assign({name: 'readNote', description: 'One note.',
    input: {schema: '/notesService/readNote/input'}, output: {schema: '/notesService/readNote/output'}}, action)]}}
}, device)});
const check = (spec) => new Promise((resolve) => validator.validateDeviceSpec(spec, (err) => resolve(err == null ? [] : (err.validationErrors || [{instancePath: '', message: err.message}]))));
const accepted = async (spec, what) => assert.deepStrictEqual(await check(spec), [], what);
const refusedAt = async (spec, pathPart, what) => {
  const errors = await check(spec);
  assert.ok(errors.length > 0, `accepted: ${what}`);
  assert.ok(errors.some((e) => String(e.instancePath).includes(pathPart)), `${what}: ${JSON.stringify(errors.map((e) => [e.instancePath, e.message]))}`);
};
const ACTION = `/device/serviceList/${SERVICE.replace(/~/g, '~0').replace(/\//g, '~1')}/actionList/0`;

describe('module-authoring 06: the declarations a module may make (MCP completeness M0)', () => {
  describe('the meta-schema: each field\'s shape and bounds', () => {
    it('a module that declares none of it is as it was', async () => {
      await accepted(specOf(), 'the plain action');
    });

    it('an action stays closed: a field this document does not name is refused', async () => {
      await refusedAt(specOf({resources: {}}), ACTION, 'an unknown action field');
      await refusedAt(specOf({'x-mcp-header': 'X-Note'}), ACTION, 'x-mcp-header on an action');
    });

    it('title: 1 to 128 characters', async () => {
      await accepted(specOf({title: 'Read a note'}));
      await accepted(specOf({title: 't'.repeat(128)}));
      for (const bad of ['', 't'.repeat(129), 7, null]) await refusedAt(specOf({title: bad}), `${ACTION}/title`, JSON.stringify(bad));
    });

    it('annotations: closed to the four hints, each a boolean', async () => {
      await accepted(specOf({annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}}));
      await accepted(specOf({annotations: {}}));
      await refusedAt(specOf({annotations: {readOnlyHint: 'yes'}}), `${ACTION}/annotations`, 'a hint that is no boolean');
      await refusedAt(specOf({annotations: {title: 'x'}}), `${ACTION}/annotations`, 'another key');
      await refusedAt(specOf({annotations: []}), `${ACTION}/annotations`, 'not an object');
    });

    it('icons: at most 4, each a file inside the module with optional sizes; never a URL', async () => {
      await accepted(specOf({icons: [{file: 'icons/note.png', sizes: ['48x48', '96x96']}, {file: 'note.webp'}]}));
      await refusedAt(specOf({icons: Array.from({length: 5}, (x, i) => ({file: `icons/${i}.png`}))}), `${ACTION}/icons`, 'five icons');
      for (const file of ['', '/etc/passwd', '../outside.png', 'icons/../../x.png', 'https://example.com/i.png', 'data:image/png;base64,AAAA', 'a\\b.png', 'x'.repeat(257)]) {
        await refusedAt(specOf({icons: [{file}]}), `${ACTION}/icons`, `file ${file.slice(0, 30)}`);
      }
      await refusedAt(specOf({icons: [{src: 'https://example.com/i.png'}]}), `${ACTION}/icons`, 'a src');
      await refusedAt(specOf({icons: [{file: 'i.png', sizes: ['big']}]}), `${ACTION}/icons`, 'a size that is not WxH');
      await refusedAt(specOf({icons: [{file: 'i.png', mimeType: 'image/png'}]}), `${ACTION}/icons`, 'a media type of the author\'s');
    });

    it('longRunning: a boolean', async () => {
      await accepted(specOf({longRunning: true}));
      await refusedAt(specOf({longRunning: 'yes'}), `${ACTION}/longRunning`, 'not a boolean');
    });

    it('questions: at most 4, each a message of at most 500 characters and a pointer to its schema', async () => {
      const q = {message: 'Replace the saved note {name}?', schema: '/notesService/readNote/questions/overwrite'};
      await accepted(specOf({questions: {overwrite: q}}));
      await accepted(specOf({questions: {a: q, b: q, c: q, d: q}}));
      await refusedAt(specOf({questions: {a: q, b: q, c: q, d: q, e: q}}), `${ACTION}/questions`, 'five questions');
      await refusedAt(specOf({questions: {overwrite: {message: 'm'.repeat(501), schema: q.schema}}}), `${ACTION}/questions`, 'a long message');
      await refusedAt(specOf({questions: {overwrite: {message: '', schema: q.schema}}}), `${ACTION}/questions`, 'an empty message');
      await refusedAt(specOf({questions: {overwrite: {message: 'm'}}}), `${ACTION}/questions`, 'no schema');
      await refusedAt(specOf({questions: {overwrite: Object.assign({title: 'x'}, q)}}), `${ACTION}/questions`, 'another key');
      await refusedAt(specOf({questions: {'has space': q}}), `${ACTION}/questions`, 'a name that is not one');
      await refusedAt(specOf({questions: [q]}), `${ACTION}/questions`, 'a list');
    });

    it('resource: a template, a name, and what passes through', async () => {
      const r = {uriTemplate: 'notes/{id}', name: 'note', title: 'Note', mimeType: 'text/markdown', changesWith: ['notesService.save', 'notesService.remove'],
        icons: [{file: 'icons/note.png'}], completion: {id: 'notesService.completeId'}};
      await accepted(specOf({resource: r}));
      await accepted(specOf({resource: {uriTemplate: 'index', name: 'index'}}));
      await refusedAt(specOf({resource: {name: 'note'}}), `${ACTION}/resource`, 'no template');
      await refusedAt(specOf({resource: {uriTemplate: 'notes/{id}'}}), `${ACTION}/resource`, 'no name');
      await refusedAt(specOf({resource: Object.assign({}, r, {uriTemplate: 't'.repeat(257)})}), `${ACTION}/resource`, 'a template over 256');
      await refusedAt(specOf({resource: Object.assign({}, r, {uriTemplate: ''})}), `${ACTION}/resource`, 'an empty template');
      await refusedAt(specOf({resource: Object.assign({}, r, {mimeType: 'markdown'})}), `${ACTION}/resource`, 'a media type that is not one');
      await refusedAt(specOf({resource: Object.assign({}, r, {changesWith: ['save']})}), `${ACTION}/resource`, 'changesWith that is no service.action');
      await refusedAt(specOf({resource: Object.assign({}, r, {completion: {id: 'completeId'}})}), `${ACTION}/resource`, 'a completion that is no service.action');
      await refusedAt(specOf({resource: Object.assign({}, r, {uri: 'countinghouse://m/notes/x'})}), `${ACTION}/resource`, 'a full URI of the author\'s');
    });

    it('promptList, on the device: at most 32 prompts, each with a name, declared messages and what passes through', async () => {
      const p = {name: 'triage', title: 'Triage a failing run', description: 'Asks for a triage of one CI run.', arguments: {schema: '/prompts/triage/arguments'},
        messages: [{role: 'user', text: 'Triage run {{run}} of {{repo}}.'}, {role: 'assistant', text: 'Starting.'}], completion: {repo: 'notesService.completeRepo'}, icons: [{file: 'icons/p.png'}]};
      await accepted(specOf({}, {promptList: [p]}));
      await accepted(specOf({}, {promptList: [{name: 'p', messages: [{role: 'user', text: 'x'}]}]}));
      await accepted(specOf({}, {promptList: Array.from({length: 32}, (x, i) => Object.assign({}, p, {name: `p${i}`}))}));
      await refusedAt(specOf({}, {promptList: Array.from({length: 33}, (x, i) => Object.assign({}, p, {name: `p${i}`}))}), '/device/promptList', '33 prompts');
      for (const name of ['', 'has space', 'n'.repeat(65), 'a/b']) await refusedAt(specOf({}, {promptList: [Object.assign({}, p, {name})]}), '/device/promptList', `name ${name.slice(0, 12)}`);
      await refusedAt(specOf({}, {promptList: [Object.assign({}, p, {messages: []})]}), '/device/promptList', 'no message');
      await refusedAt(specOf({}, {promptList: [Object.assign({}, p, {messages: Array.from({length: 9}, () => ({role: 'user', text: 'x'}))})]}), '/device/promptList', 'nine messages');
      await refusedAt(specOf({}, {promptList: [Object.assign({}, p, {messages: [{role: 'system', text: 'x'}]})]}), '/device/promptList', 'a system role');
      await refusedAt(specOf({}, {promptList: [Object.assign({}, p, {messages: [{role: 'user', text: ''}]})]}), '/device/promptList', 'an empty text');
      await refusedAt(specOf({}, {promptList: [Object.assign({}, p, {messages: [{role: 'user', content: {type: 'text', text: 'x'}}]})]}), '/device/promptList', 'MCP\'s own message shape');
      await refusedAt(specOf({}, {promptList: [Object.assign({}, p, {handler: 'notesService.prompt'})]}), '/device/promptList', 'an action-backed prompt');
      await refusedAt(specOf({}, {promptList: {triage: p}}), '/device/promptList', 'a map');
    });

    it('every field together, at its bounds, is one valid action', async () => {
      await accepted(specOf({title: 'Read', annotations: {readOnlyHint: true}, icons: [{file: 'i.png'}], longRunning: false,
        questions: {confirm: {message: 'Read {id}?', schema: '/notesService/readNote/questions/confirm'}}}));
    });
  });
});
