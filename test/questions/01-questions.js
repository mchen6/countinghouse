'use strict';
// MCP completeness M13 (docs/superpowers/specs/2026-11-15-mcp-completeness-design.md,
// section 8): a module's question, as the main thread makes it. Server-free.
//
// A question is declared (api.json's `questions`, checked by M0), never
// composed by the module: ctx.ask gives a question's name and the values of
// its message's placeholders, and the runtime composes what the user reads,
// "<module name>: <message>". The question's key, which an answer is held
// under, is a hash of the module, the action, the question's name and that
// composed text, so an answer applies only to a question with the same text.
const assert = require('assert');
const path = require('path');
const questions = require('../../lib/module-questions');

const SERVICE = 'urn:countinghouse-test:serviceID:notesService';
const SPEC = require(path.join(__dirname, '..', 'fixtures', 'declares-everything', 'api.json'));

describe('questions 01: a module\'s question, as the runtime composes it (MCP completeness M13)', () => {
  describe('the dialog\'s text', () => {
    it('is "<module name>: <message>", each {name} replaced by its value', () => {
      assert.strictEqual(questions.composed('notes', 'Replace the saved note {id}?', {id: 'first'}), 'notes: Replace the saved note first?');
      assert.strictEqual(questions.composed('notes', 'Keep {n} copies ({all}, {ratio})?', {n: 3, all: true, ratio: 0.5}), 'notes: Keep 3 copies (true, 0.5)?');
      assert.strictEqual(questions.composed('notes', 'Go on?', {}), 'notes: Go on?');
      assert.strictEqual(questions.composed('notes', 'Go on?'), 'notes: Go on?', 'no values for a message with no placeholder');
      // a value given twice in the message is said twice; one the message does not name is not said
      assert.strictEqual(questions.composed('notes', '{id}, yes {id}?', {id: 'a', other: 'never'}), 'notes: a, yes a?');
    });

    it('a value is text, never a placeholder: what is put in is not read again', () => {
      assert.strictEqual(questions.composed('notes', 'A {id} and {other}', {id: '{other}', other: 'x'}), 'notes: A {other} and x');
      assert.strictEqual(questions.composed('notes', 'A {id}', {id: '$& $1 {id}'}), 'notes: A $& $1 {id}');
    });

    it('a string value is cut to 200 characters and loses its control and bidi characters', () => {
      assert.strictEqual(questions.composed('notes', '[{v}]', {v: 'a\nb‮c\u0007d⁦e\u001b[31m'}), 'notes: [abcde[31m]');
      assert.strictEqual(questions.composed('notes', '[{v}]', {v: 'a\tb'}), 'notes: [a b]', 'a tab is a space');
      assert.strictEqual(questions.composed('notes', '[{v}]', {v: 'x'.repeat(300)}), `notes: [${'x'.repeat(200)}]`);
      // a character outside the BMP is one character, and is never cut in half
      const out = questions.composed('notes', '[{v}]', {v: '\u{1F600}'.repeat(250)});
      assert.strictEqual(out, `notes: [${'\u{1F600}'.repeat(200)}]`);
    });

    it('the whole text is at most 1000 characters', () => {
      const message = `${'{a}{b}{c}{d}{e}{f}'}?`;
      const values = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [k, k.repeat(200)]));
      const out = questions.composed('notes', message, values);
      assert.strictEqual(Array.from(out).length, 1000);
      assert.ok(out.startsWith(`notes: ${'a'.repeat(200)}${'b'.repeat(200)}`));
    });

    it('the module\'s name is cut and cleaned as a value is', () => {
      assert.strictEqual(questions.composed('no‮tes\n', 'Go on?'), 'notes: Go on?');
      assert.strictEqual(questions.composed('m'.repeat(100), 'Go on?'), `${'m'.repeat(64)}: Go on?`);
    });

    it('a value that is missing, or not a string, a finite number or a boolean, is the module\'s error: ASK_NOT_DECLARED', () => {
      const refused = (values) => assert.throws(() => questions.composed('notes', 'Replace {id}?', values), (e) => e.code === 'ASK_NOT_DECLARED' && /\{id\}/.test(e.message), JSON.stringify(values));
      for (const values of [undefined, null, {}, {other: 'x'}, {id: null}, {id: undefined}, {id: {}}, {id: ['a']}, {id: NaN}, {id: Infinity}, 'id', 7, ['id']]) refused(values);
      assert.throws(() => questions.composed('notes', 'Replace {id}?', {id: 10n}), (e) => e.code === 'ASK_NOT_DECLARED');
      assert.throws(() => questions.composed('notes', 'Replace {id}?', {id: () => 'x'}), (e) => e.code === 'ASK_NOT_DECLARED');
      // an inherited value is not one given
      assert.throws(() => questions.composed('notes', 'Replace {toString}?', {}), (e) => e.code === 'ASK_NOT_DECLARED');
      // and the error's text does not carry the value
      assert.throws(() => questions.composed('notes', 'Replace {id}?', {id: {secret: 's3cret'}}), (e) => !/s3cret/.test(e.message));
    });
  });

  describe('a question\'s key', () => {
    const key = (over = {}) => questions.keyOf(Object.assign({module: 'notes', serviceID: SERVICE, action: 'saveNote', question: 'overwrite', text: 'notes: Replace the saved note first?'}, over));

    it('is 43 characters of base64url, the same for the same question', () => {
      assert.match(key(), /^[A-Za-z0-9_-]{43}$/);
      assert.strictEqual(key(), key());
    });

    it('differs with the module, the service, the action, the question\'s name and the text: an answer to "Delete A?" is none to "Delete B?"', () => {
      const all = [key(), key({module: 'other'}), key({serviceID: 'urn:countinghouse-test:serviceID:otherService'}), key({action: 'readNote'}), key({question: 'confirm'}),
        key({text: 'notes: Replace the saved note second?'})];
      assert.strictEqual(new Set(all).size, all.length);
    });

    it('no two different questions give the same bytes to the hash', () => {
      assert.notStrictEqual(key({module: 'ab', action: 'c'}), key({module: 'a', action: 'bc'}));
      assert.notStrictEqual(key({question: 'a","b'}), key({question: 'a', text: 'b'}));
    });

    it('refuses to make one of anything but five strings', () => {
      for (const over of [{module: null}, {serviceID: 7}, {action: undefined}, {question: {}}, {text: ['x']}]) assert.throws(() => key(over), /module-questions/, JSON.stringify(over));
    });
  });

  describe('the declaration', () => {
    it('is the action\'s own, read from api.json as the main thread holds it: by service, action and question name', () => {
      assert.deepStrictEqual(questions.declared(SPEC, SERVICE, 'saveNote', 'overwrite'),
        {message: 'Replace the saved note {id}?', schema: '/notesService/saveNote/questions/overwrite'});
    });

    it('nothing else is a question: another action\'s, an unknown name, a name every object has', () => {
      for (const [service, action, name] of [[SERVICE, 'readNote', 'overwrite'], [SERVICE, 'saveNote', 'other'], [SERVICE, 'none', 'overwrite'], ['urn:x:serviceID:y', 'saveNote', 'overwrite'],
        [SERVICE, 'saveNote', 'constructor'], [SERVICE, 'saveNote', '__proto__'], [SERVICE, 'saveNote', 'toString'], [SERVICE, 'saveNote', ''], [SERVICE, 'saveNote', 7], [SERVICE, 'saveNote', null],
        ['__proto__', 'saveNote', 'overwrite'], [SERVICE, '__proto__', 'overwrite']]) {
        assert.strictEqual(questions.declared(SPEC, service, action, name), null, JSON.stringify([service, action, name]));
      }
      for (const junk of [null, undefined, 7, 'x', {}, {device: null}, {device: {serviceList: 7}}, {device: {serviceList: {[SERVICE]: {actionList: 'x'}}}}]) {
        assert.strictEqual(questions.declared(junk, SERVICE, 'saveNote', 'overwrite'), null, JSON.stringify(junk));
      }
    });

    it('a declaration that is not a message and a pointer is none (the meta-schema refuses such a module; this does not trust that it did)', () => {
      const spec = JSON.parse(JSON.stringify(SPEC));
      const save = spec.device.serviceList[SERVICE].actionList.find((a) => a.name === 'saveNote');
      for (const bad of [null, 'x', [], {message: 'only'}, {schema: '/only'}, {message: 7, schema: '/x'}, {message: 'x', schema: {}}]) {
        save.questions.overwrite = bad;
        assert.strictEqual(questions.declared(spec, SERVICE, 'saveNote', 'overwrite'), null, JSON.stringify(bad));
      }
    });
  });
});
