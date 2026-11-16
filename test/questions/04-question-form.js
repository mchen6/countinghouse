'use strict';
// MCP completeness M13 (the design, section 8): a question's form and its
// answer are a module's schema, so they are read and checked in a validator
// worker (lib/validator-pool.js), never on the main thread. Server-free:
// the real pool, the fixture's files.
//
//   moduleSpec.question(own, pointer)            -> {schema, valid: null}
//   moduleSpec.question(own, pointer, content)   -> {schema, valid: boolean}
//
// An answer holds the form's own properties and no other, whatever the form
// says of additional ones.
const assert = require('assert');
const path = require('path');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'declares-everything');
const POINTER = '/notesService/saveNote/questions/overwrite';

describe('questions 04: a question\'s form and its answer, in a validator (MCP completeness M13)', function() {
  this.timeout(30000);
  let moduleSpec = null;
  let own = null;
  // The pool's own lines, held as module-loading 24 holds them: this file
  // makes no logger, so a line the pool logged (a deadline missed on a
  // loaded machine) would otherwise end the run as a TypeError of the
  // logger's, with nothing of what was missed.
  const LOG = require('../../lib/logger');
  const logged = [];
  let logE = null;
  let logW = null;
  // A spec as a load leaves it: built, then compiled in the validators
  // (lib/module-spec.js warm), so a question finds a validator ready. A
  // question has a call's budget (1 s), which a pool still starting can miss.
  const loaded = async (dir, name) => {
    const spec = await moduleSpec.build(dir, name);
    assert.strictEqual(spec.error, undefined, String(spec.error));
    assert.strictEqual(await moduleSpec.warm(spec), null, `${name} compiles; the pool said: ${logged.join(' | ')}`);
    return spec;
  };
  before(async () => {
    // a fresh shared pool, whatever ran before this file in the same mocha
    // process (CI's functional run: module-loading 23 closed it, #311)
    require('../../lib/validator-pool').closeShared();
    logE = LOG.E;
    logW = LOG.W;
    LOG.E = (e) => { logged.push(String(e && e.message)); return e; };
    LOG.W = (m) => { logged.push(String(m)); return m; };
    require('../../lib/cli-options').setOptions({workerThread: true});
    moduleSpec = require('../../lib/module-spec');
    own = await loaded(FIXTURE, 'declares-everything');
  });
  after(() => {
    // closed and forgotten, so a later file starts a pool of its own
    require('../../lib/validator-pool').closeShared();
    require('../../lib/cli-options').setOptions({workerThread: false});
    LOG.E = logE;
    LOG.W = logW;
  });
  // what the pool said while a case ran is in that case's failure
  afterEach(function() {
    if (this.currentTest.state === 'failed' && logged.length > 0) this.currentTest.err.message += `\n  the pool logged: ${logged.join(' | ')}`;
    logged.length = 0;
  });

  it('the form is the schema the question points to, as schema.json has it', async () => {
    const got = await moduleSpec.question(own, POINTER);
    assert.strictEqual(got.valid, null);
    assert.deepStrictEqual(got.schema, require(path.join(FIXTURE, 'schema.json')).notesService.saveNote.questions.overwrite);
  });

  it('an answer that fits the form is valid; one that does not is not', async () => {
    const valid = async (content) => (await moduleSpec.question(own, POINTER, content)).valid;
    assert.strictEqual(await valid({replace: true}), true);
    assert.strictEqual(await valid({replace: false, note: 'kept', copies: 2, weight: 0.5, mode: 'append'}), true);
    for (const bad of [{}, {replace: 'yes'}, {replace: true, copies: 9}, {replace: true, copies: 1.5}, {replace: true, mode: 'other'}, {replace: true, note: 'n'.repeat(201)}, {note: 'no replace'},
      null, [], 'yes', 7, true]) {
      assert.strictEqual(await valid(bad), false, JSON.stringify(bad));
    }
  });

  it('an answer holds the form\'s own properties and no other', async () => {
    assert.strictEqual((await moduleSpec.question(own, POINTER, {replace: true, extra: 'x'})).valid, false);
    assert.strictEqual((await moduleSpec.question(own, POINTER, {replace: true, __proto__: {x: 1}})).valid, true, 'an inherited one is not sent');
  });

  // /code-review of M13, 1: a form may carry what a client shows and a validator does not know (enumNames):
  // the answer is checked against the form's rules alone
  it('a form with enumNames is answered: what only a client reads is no part of the check', async () => {
    const asks = await loaded(path.join(__dirname, '..', 'fixtures', 'asks-questions'), 'asks-questions');
    const pointer = '/askService/probe/questions/confirm';
    const shown = await moduleSpec.question(asks, pointer);
    assert.deepStrictEqual(shown.schema.properties.when.enumNames, ['Now', 'Later'], 'the client still gets it');
    assert.strictEqual((await moduleSpec.question(asks, pointer, {yes: true, when: 'later'})).valid, true);
    assert.strictEqual((await moduleSpec.question(asks, pointer, {yes: true, when: 'Later'})).valid, false, 'a name is no value');
    assert.strictEqual((await moduleSpec.question(asks, pointer, {yes: true})).valid, true);
  });

  it('a pointer that names no schema has no form, and nothing is valid for it', async () => {
    for (const pointer of ['/notesService/saveNote/questions/none', '/nowhere', '', 'notesService', 7, null]) {
      assert.deepStrictEqual(await moduleSpec.question(own, pointer, {replace: true}), {schema: null, valid: null}, JSON.stringify(pointer));
    }
  });

  it('a spec the validators do not hold has no form: asked of none, it answers null', async () => {
    assert.strictEqual(await moduleSpec.question(null, POINTER, {replace: true}), null);
    assert.strictEqual(await moduleSpec.question({error: 'unread'}, POINTER), null);
    assert.strictEqual(await moduleSpec.question({key: 'never-loaded#1'}, POINTER), null);
  });

  it('a module\'s calls are checked as before, beside its questions', async () => {
    const SERVICE = 'urn:countinghouse-test:serviceID:notesService';
    const checked = moduleSpec.checkInput(own, own.deviceID, SERVICE, 'readNote', {input: {id: 7}});
    const refused = await moduleSpec.validate(checked, 'input', {input: {id: 7}});
    assert.strictEqual(refused[0].code, 'INPUT_DATA_VALIDATION_FAIL');
    assert.strictEqual((await moduleSpec.question(own, POINTER, {replace: true})).valid, true);
  });
});
