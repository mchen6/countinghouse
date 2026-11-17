'use strict';
// MCP completeness M18, the final security pass (d): text a module declares
// reaches the agent cleaned, where it leaves for the client (never refused
// or changed at load). Each hidden character (countinghouse's one class,
// lib/conditions-why.json hiddenClass: controls, line separators, bidi,
// zero-width, tags, variation selectors, fillers...) becomes a space, as
// declaredText and ch-local's clean-text do; a prompt message keeps its \n
// and \t; (a resource's name is an identifier, by the meta-schema); an emoji sequence keeps its joiner (ZWJ between two pictographic
// characters) and its VS-16 (right after one). Every surface: a tool's title
// and description, a prompt's title, description, arguments' descriptions
// and messages, a resource's and a template's name, title and description,
// a question's dialog text. A completion candidate is a value the client
// sends back, so one with a hidden character is left out, never changed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const clientText = require('../../lib/client-text');
const {startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {withoutRedisNoise} = require('../helpers/stdio-client');

const PORT = testPort(9755);
const V = '2026-07-28';
const KEY = `test-k-${'k'.repeat(24)}`;
// one of each kind, spelled in escapes only
const ZWSP = '​';
const LRI = '⁦';
const TAG_A = '\u{e0041}';
const NBSP_HANGUL = 'ㅤ';
const ZWJ = '‍';
const VS16 = '️';
const FAMILY = `\u{1f468}${ZWJ}\u{1f469}${ZWJ}\u{1f467}`;
const HEART = `❤${VS16}`;
const ZWNJ = '\u200c';
// Scotland's flag: a black flag, tag letters, a cancel tag
const SCOTLAND = `\u{1f3f4}${['g', 'b', 's', 'c', 't'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')}\u{e007f}`;
const hidden = new RegExp(`[${require('../../lib/conditions-why.json').hiddenClass}]`, 'u');

describe('mcp-contract 34: declared text reaches the client cleaned (M18)', function() {
  this.timeout(120000);

  describe('the cleaner (lib/client-text.js)', () => {
    it('every hidden character is a space, one for one', () => {
      // a member of each range of the class
      const members = ['\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\u009f', '­', '͏', '؜', 'ᅟ', 'ᅠ', '᠎', ZWSP, '‏',
        ' ', '‮', '⁠', LRI, '⁩', '⠀', NBSP_HANGUL, '\ud800', '\udfff', '︀', VS16, '﻿', 'ﾠ', '￹', '￻',
        '\u{1d173}', '\u{1d17a}', '\u{e0000}', TAG_A, '\u{e007f}', '\u{e0100}', '\u{e01ef}'];
      for (const c of members) {
        assert.ok(hidden.test(c), `${c.codePointAt(0).toString(16)} is in the class`);
        assert.strictEqual(clientText.line(`a${c}b`), 'a b', c.codePointAt(0).toString(16));
      }
      assert.strictEqual(clientText.line('plain text, untouched: é ü 日本 \u{1f600}'), 'plain text, untouched: é ü 日本 \u{1f600}');
    });

    it('a message keeps its \\n and \\t; a line makes them spaces too', () => {
      assert.strictEqual(clientText.message(`one${ZWSP}\ntwo\tthree\r\n`), 'one \ntwo\tthree \n');
      assert.strictEqual(clientText.line('one\ntwo\tthree'), 'one two three');
    });

    it('an emoji sequence keeps its joiner and its VS-16; anywhere else they are spaces', () => {
      assert.strictEqual(clientText.line(`${FAMILY} ${HEART}`), `${FAMILY} ${HEART}`);
      // a skin tone between: still one sequence
      const tones = `\u{1f469}\u{1f3fd}${ZWJ}\u{1f4bb}`;
      assert.strictEqual(clientText.line(tones), tones);
      // a joiner at either end, or doubled, and a VS-16 after a letter or a digit
      assert.strictEqual(clientText.line(`${ZWJ}\u{1f600}`), ' \u{1f600}');
      assert.strictEqual(clientText.line(`\u{1f600}${ZWJ}`), '\u{1f600} ');
      assert.strictEqual(clientText.line(`\u{1f600}${ZWJ}${ZWJ}\u{1f600}`), '\u{1f600}  \u{1f600}');
      assert.strictEqual(clientText.line(`x${VS16}`), 'x ');
      assert.strictEqual(clientText.line(`1${VS16}⃣`), '1 ⃣', 'a keycap loses its VS-16 (a digit is not pictographic)');
    });

    // the reviewer's ruling on #378's review, (5): a joiner between two
    // letters only shapes them (Persian, Arabic, Indic spelling), in any script
    it('a ZWNJ or ZWJ between two letters is kept (combining marks between allowed); next to anything else, or at an edge, a space', () => {
      const persian = `\u0645\u06cc${ZWNJ}\u062e\u0648\u0627\u0647\u0645`;
      assert.strictEqual(clientText.line(persian), persian);
      assert.strictEqual(clientText.hasHidden(persian), false);
      // Devanagari: ka, virama (a mark), ZWJ, ssa
      const conjunct = `\u0915\u094d${ZWJ}\u0937`;
      assert.strictEqual(clientText.line(conjunct), conjunct);
      assert.strictEqual(clientText.line(`a${ZWJ}b`), `a${ZWJ}b`);
      assert.strictEqual(clientText.line(`a${ZWNJ}1`), 'a 1');
      assert.strictEqual(clientText.line(`1${ZWJ}a`), '1 a');
      assert.strictEqual(clientText.line(`${ZWNJ}a`), ' a');
      assert.strictEqual(clientText.line(`a${ZWJ}`), 'a ');
      assert.strictEqual(clientText.line(`a ${ZWNJ}b`), 'a  b');
      assert.strictEqual(clientText.line(`a${ZWNJ}${ZWNJ}b`), 'a  b', 'two joiners: neither sits between two letters');
      assert.strictEqual(clientText.line(`a${ZWSP}b`), 'a b', 'a zero-width space is no joiner');
    });

    // the ruling's (6): a subdivision flag keeps its tag letters and cancel tag
    it('a black flag\'s tag run, ending in its cancel tag, is kept; stray tags are spaces', () => {
      assert.strictEqual(clientText.line(`go ${SCOTLAND}!`), `go ${SCOTLAND}!`);
      assert.strictEqual(clientText.hasHidden(SCOTLAND), false);
      assert.strictEqual(clientText.line(`a${TAG_A}b`), 'a b');
      // no cancel tag, or no black flag before: every tag a space
      const unended = `\u{1f3f4}${TAG_A}${TAG_A}`;
      assert.strictEqual(clientText.line(unended), '\u{1f3f4}  ');
      assert.strictEqual(clientText.line(`x${TAG_A}\u{e007f}`), 'x  ');
    });

    it('hasHidden: a candidate with any hidden character, an emoji sequence\'s joiner apart', () => {
      assert.strictEqual(clientText.hasHidden(`b${ZWSP}ob`), true);
      assert.strictEqual(clientText.hasHidden(FAMILY), false);
      assert.strictEqual(clientText.hasHidden('bob'), false);
    });
  });

  // register follow-up (3), as ruled: inside an advertised schema, text at
  // a keyword's place is cleaned (title a line; description and $comment
  // keep \n and \t); names and data are never changed, only left out
  describe('an advertised schema (clientText.schema)', () => {
    const input = (s) => clientText.schema(s);
    it('title, description and $comment cleaned at keyword places; names, pattern and format as declared', () => {
      const declared = {type: 'object', title: `A${ZWSP}b`, description: `One${LRI}\ntwo`, $comment: `c${TAG_A}`,
        properties: {title: {type: 'string', title: `T${ZWSP}`, pattern: '^a​b$', format: 'email'}, description: {type: 'string'}}};
      const got = input(declared);
      assert.strictEqual(got.unusable, false);
      assert.deepStrictEqual(got.schema, {type: 'object', title: 'A b', description: 'One \ntwo', $comment: 'c ',
        properties: {title: {type: 'string', title: 'T ', pattern: '^a​b$', format: 'email'}, description: {type: 'string'}}});
      assert.notStrictEqual(got.schema, declared, 'a copy, never the declared object');
      assert.strictEqual(declared.title, `A${ZWSP}b`, 'the declared schema is unchanged');
    });

    it('an enum member, an example or a default with a hidden character is left out, never changed; enumNames stay aligned', () => {
      const got = input({type: 'object', properties: {
        pick: {type: 'string', enum: ['a', `b${ZWSP}`, 'c'], enumNames: [`A${ZWSP}`, 'B', 'C']},
        ex: {type: 'string', examples: [`x${ZWSP}`, 'y'], default: `d${ZWSP}`},
        allHidden: {type: 'string', examples: [`x${ZWSP}`]},
        fine: {type: 'string', default: 'ok', enum: ['ok', 1, null]}}});
      assert.deepStrictEqual(got.schema.properties.pick, {type: 'string', enum: ['a', 'c'], enumNames: ['A ', 'C']});
      assert.deepStrictEqual(got.schema.properties.ex, {type: 'string', examples: ['y']});
      assert.deepStrictEqual(got.schema.properties.allHidden, {type: 'string'});
      assert.deepStrictEqual(got.schema.properties.fine, {type: 'string', default: 'ok', enum: ['ok', 1, null]});
    });

    it('an optional property named with a hidden character, or whose enum or const is left with nothing, is left out', () => {
      const got = input({type: 'object', required: ['keep'], properties: {
        keep: {type: 'string'}, [`na${ZWSP}me`]: {type: 'string'}, empty: {enum: [`x${ZWSP}`]}, gone: {const: `y${ZWSP}`}}});
      assert.strictEqual(got.unusable, false);
      assert.deepStrictEqual(Object.keys(got.schema.properties), ['keep']);
    });

    it('a required one makes the schema unusable (the tool not listed; a question unavailable)', () => {
      assert.strictEqual(input({type: 'object', required: [`na${ZWSP}me`], properties: {[`na${ZWSP}me`]: {type: 'string'}}}).unusable, true);
      assert.strictEqual(input({type: 'object', required: ['e'], properties: {e: {enum: [`x${ZWSP}`]}}}).unusable, true);
      // nested: a required object whose own required property goes
      assert.strictEqual(input({type: 'object', required: ['o'], properties: {o: {type: 'object', required: ['e'], properties: {e: {const: `x${ZWSP}`}}}}}).unusable, true);
      // a oneOf of titled consts (a form's choices): a hidden one leaves; all hidden, unusable
      const choices = input({type: 'object', properties: {c: {oneOf: [{const: 'a', title: `A${ZWSP}`}, {const: `b${ZWSP}`, title: 'B'}]}}});
      assert.deepStrictEqual(choices.schema.properties.c, {oneOf: [{const: 'a', title: 'A '}]});
      assert.strictEqual(input({type: 'object', required: ['c'], properties: {c: {oneOf: [{const: `b${ZWSP}`}]}}}).unusable, true);
    });

    it('an output schema: only title, description and $comment cleaned; its data and names as declared (the client checks results against them)', () => {
      const declared = {type: 'object', title: `O${ZWSP}`, properties: {[`na${ZWSP}me`]: {type: 'string', enum: [`x${ZWSP}`], description: `d${LRI}`}}, required: [`na${ZWSP}me`]};
      const got = clientText.schema(declared, {output: true});
      assert.strictEqual(got.unusable, false);
      assert.deepStrictEqual(got.schema, {type: 'object', title: 'O ', properties: {[`na${ZWSP}me`]: {type: 'string', enum: [`x${ZWSP}`], description: 'd '}}, required: [`na${ZWSP}me`]});
    });

    it('subschemas under an unknown keyword are walked; the unknown keyword\'s own text is as declared', () => {
      const got = input({type: 'object', 'x-label': `L${ZWSP}`, 'x-more': {title: `M${ZWSP}`}});
      assert.deepStrictEqual(got.schema, {type: 'object', 'x-label': `L${ZWSP}`, 'x-more': {title: 'M '}});
    });

    // the code review's findings on the first version
    it('a property named __proto__ is a property of the copy, never its prototype', () => {
      const declared = JSON.parse('{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string","title":"P​"}}}');
      const got = input(declared);
      assert.strictEqual(got.unusable, false);
      assert.ok(Object.hasOwn(got.schema.properties, '__proto__'));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(got.schema)), JSON.parse('{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string","title":"P "}}}'));
    });

    it('if, not, contains and propertyNames keep their data (false there would change what is allowed); an unknown keyword\'s object too', () => {
      const declared = {type: 'object', if: {required: ['mode'], properties: {mode: {const: `a${ZWSP}`}}}, then: {}, else: {required: ['extra']},
        properties: {list: {type: 'array', contains: {const: `x${ZWSP}`}}}, 'x-ui': {default: `t${ZWSP}`, const: `v${ZWSP}`, title: `U${ZWSP}`}};
      const got = input(declared);
      assert.strictEqual(got.unusable, false);
      assert.deepStrictEqual(got.schema.if, declared.if);
      assert.deepStrictEqual(got.schema.properties.list.contains, declared.properties.list.contains);
      assert.deepStrictEqual(got.schema['x-ui'], {default: `t${ZWSP}`, const: `v${ZWSP}`, title: 'U '});
    });

    it('a definition nothing can satisfy is kept as false, so a $ref to it still resolves', () => {
      const got = input({type: 'object', properties: {c: {$ref: '#/$defs/C'}}, $defs: {C: {const: `x${ZWSP}`}}});
      assert.deepStrictEqual(got.schema.$defs, {C: false});
      assert.deepStrictEqual(got.schema.properties.c, {$ref: '#/$defs/C'});
    });

    it('enumNames not one for each member: left out rather than misaligned', () => {
      const got = input({type: 'string', enum: ['a', `b${ZWSP}`, 'c'], enumNames: ['A']});
      assert.deepStrictEqual(got.schema, {type: 'string', enum: ['a', 'c']});
    });

    it('the load\'s warning says what the gateway does, through a $ref', () => {
      const api = {device: {friendlyName: 'r', manufacturer: 't', modelDescription: 'r', serviceList: {'urn:t:serviceID:s': {actionList: [
        {name: 'a', description: 'A.', input: {schema: '/s/a/input'}, output: {schema: '/s/a/output'}}]}}}};
      const doc = {$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object', $defs: {Choice: {enum: [`x${ZWSP}`]}},
        s: {a: {input: {type: 'object', required: ['c'], properties: {c: {$ref: '#/$defs/Choice'}}}, output: {type: 'object'}}}};
      const said = require('../../lib/declarations').check(api, doc).warnings.map((w) => w.message).join('\n');
      assert.match(said, /hidden character.*not listed/, said);
    });

    it('a schema with a cycle is copied once per node; the same declared schema gives the same copy (kept)', () => {
      const node = {type: 'object', title: `C${ZWSP}`, properties: {}};
      node.properties.self = node;
      const got = input(node);
      assert.strictEqual(got.schema.properties.self, got.schema);
      assert.strictEqual(input(node).schema, got.schema, 'kept per declared object');
    });
  });

  // #378's review (7): cut first, then cleaned, so no kept joiner is left
  // dangling at the cut
  it('a question\'s dialog cut at its limit ends in no hidden character', () => {
    const text = require('../../lib/module-questions').composed('m', `${'x'.repeat(995)}\u{1f468}${ZWJ}\u{1f469}`, {});
    assert.ok(!clientText.hasHidden(text), JSON.stringify(text.slice(-4)));
  });

  describe('every surface, spawned', () => {
    let server = null;
    let dir = null;
    const log = () => `\n${withoutRedisNoise((server && server.output) || '', 3000)}`;
    const modern = (method, params = {}, caps = {}) => request(`http://127.0.0.1:${PORT}`).post('/mcp').set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream').set('X-CH-Key', KEY).set('MCP-Protocol-Version', V).set('Mcp-Method', method)
      .set(typeof(params.name) === 'string' ? {'Mcp-Name': params.name} : (typeof(params.taskId) === 'string' ? {'Mcp-Name': params.taskId} : {}))
      .send({jsonrpc: '2.0', id: 1, method, params: Object.assign({_meta: {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': caps}}, params)})
      .then((res) => res.body);
    // no hidden character left anywhere in what the client was sent (what
    // the cleaner keeps apart: an emoji's joiner, a word's, a flag's tags,
    // and a description's or a message's \n and \t)
    const clean = (value, what) => {
      const text = JSON.stringify(value);
      const left = JSON.parse(text);
      const walk = (v, at) => {
        if (typeof(v) === 'string') assert.ok(clientText.message(v) === v, `${what}: a hidden character at ${at}: ${JSON.stringify(v)}`);
        else if (v != null && typeof(v) === 'object') for (const k of Object.keys(v)) walk(v[k], `${at}.${k}`);
      };
      walk(left, what);
    };

    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-mcp-34-'));
      const mod = path.join(dir, 'hidden-text');
      const svc = 'textService';
      fs.mkdirSync(path.join(mod, 'handlers', svc), {recursive: true});
      fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({name: 'hidden-text', version: '1.0.0', license: 'Apache-2.0'}));
      fs.writeFileSync(path.join(mod, 'api.json'), JSON.stringify({device: {friendlyName: 'hidden-text', manufacturer: 'countinghouse-test', modelDescription: 'declared text with hidden characters',
        serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [
          {name: 'show', title: `Show${ZWSP} it`, description: `Shows${LRI} a thing${TAG_A}, ${FAMILY}.\nArgs:\twhat`,
            input: {schema: `/${svc}/show/input`}, output: {schema: `/${svc}/show/output`},
            questions: {confirm: {message: `Go${ZWSP} on with {what}?`, schema: `/${svc}/show/questions/confirm`}}},
          {name: 'stuck', description: 'A tool whose required choice has only hidden members.', input: {schema: `/${svc}/stuck/input`}, output: {schema: `/${svc}/stuck/output`}},
          {name: 'askStuck', description: 'Asks a question whose required choice has only hidden members.', input: {schema: `/${svc}/askStuck/input`},
            output: {schema: `/${svc}/askStuck/output`}, questions: {pick: {message: 'Pick one?', schema: `/${svc}/askStuck/questions/pick`}}},
          {name: 'askStuckTask', description: 'The same question, from inside a task.', input: {schema: `/${svc}/askStuck/input`},
            output: {schema: `/${svc}/askStuck/output`}, questions: {pick: {message: 'Pick one?', schema: `/${svc}/askStuck/questions/pick`}}, longRunning: true},
          {name: 'item', description: `One item${NBSP_HANGUL}.`, input: {schema: `/${svc}/item/input`}, output: {schema: `/${svc}/item/output`},
            annotations: {readOnlyHint: true},
            resource: {uriTemplate: 'items/{id}', name: 'item', title: `An${LRI} item`, description: `One${TAG_A} item.\nBy id.`, completion: {id: `${svc}.completeId`}}},
          {name: 'completeId', description: 'Completes an item id.', input: {schema: `/${svc}/completeId/input`}, output: {schema: `/${svc}/completeId/output`}},
          {name: 'blank', description: `${ZWSP}\u2060`, input: {schema: `/${svc}/blank/input`}, output: {schema: `/${svc}/blank/output`}},
          {name: 'blob', description: 'A file.', input: {schema: `/${svc}/blob/input`}, output: {schema: `/${svc}/blob/output`}},
          {name: 'all', description: 'Every item.', output: {schema: `/${svc}/all/output`}, annotations: {readOnlyHint: true},
            resource: {uriTemplate: 'items', name: 'items', title: `All${LRI} items`}}
        ]}},
        promptList: [{name: 'greet', title: `Greet${ZWSP}`, description: `Says${LRI} hello`, arguments: {schema: '/prompts/greet/arguments'},
          messages: [{role: 'user', text: `Hello {{who}}${ZWSP}!\nLine two\tends ${FAMILY} ${HEART} a${ZWJ}b 1${ZWJ}2`}]},
        {name: 'sneaky', description: 'An argument named with a hidden character.', arguments: {schema: '/prompts/sneaky/arguments'},
          messages: [{role: 'user', text: 'Hello.'}]}]}}));
      fs.writeFileSync(path.join(mod, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
        [svc]: {show: {input: {type: 'object', title: `In${ZWSP}put`, properties: {what: {type: 'string', description: `What${LRI}\nto show`},
          mood: {type: 'string', enum: ['calm', `wi${ZWSP}ld`]}, [`na${ZWSP}me`]: {type: 'string'}, empty: {enum: [`x${ZWSP}`]}}},
          output: {type: 'object', title: `Out${ZWSP}`, properties: {status: {type: 'string', enum: ['ok', `o${ZWSP}k`]}}},
          questions: {confirm: {type: 'object', properties: {yes: {type: 'boolean', title: 'Yes'},
            how: {type: 'string', title: `How${ZWSP}`, enum: ['now', `la${ZWSP}ter`, 'soon'], enumNames: ['Now', 'Later', `So${TAG_A}on`]}}, required: ['yes']}}},
        stuck: {input: {type: 'object', 'x-label': `L${ZWSP}`, required: ['mode'], properties: {mode: {enum: [`a${ZWSP}`]}}}, output: {type: 'object'}},
        askStuck: {input: {type: 'object'}, output: {type: 'object'},
          questions: {pick: {type: 'object', properties: {c: {type: 'string', title: 'Choice', enum: [`x${ZWSP}`]}}, required: ['c']}}},
        item: {input: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']}, output: {type: 'object'}},
        all: {output: {type: 'object'}},
        blank: {input: {type: 'object'}, output: {type: 'object'}},
        blob: {input: {type: 'object'}, output: {type: 'object', properties: {file: {type: 'string', contentEncoding: 'base64', contentMediaType: 'application/octet-stream',
          description: `Report${LRI} file`}}}},
        completeId: {input: {type: 'object', properties: {argument: {type: 'string'}, value: {type: 'string'}, context: {type: 'object'}}, required: ['argument', 'value']},
          output: {type: 'object', properties: {values: {type: 'array', items: {type: 'string'}}}, required: ['values']}}},
        prompts: {greet: {arguments: {type: 'object', properties: {who: {type: 'string', description: `Who${ZWSP} to greet\nby name`, enum: ['ann', `b${ZWSP}ob`, 'bea']}}, required: ['who']}},
          sneaky: {arguments: {type: 'object', properties: {[`wh${ZWSP}o`]: {type: 'string'}}}}}}));
      fs.writeFileSync(path.join(mod, 'handlers', svc, 'show.js'), 'module.exports = async (input, ctx) => ({output: {answer: await ctx.ask(\'confirm\', {what: input.what || \'it\'})}});\n');
      fs.writeFileSync(path.join(mod, 'handlers', svc, 'item.js'), 'module.exports = async (input) => ({output: {id: input.id}});\n');
      fs.writeFileSync(path.join(mod, 'handlers', svc, 'stuck.js'), 'module.exports = async () => ({output: {}});\n');
      fs.writeFileSync(path.join(mod, 'handlers', svc, 'askStuck.js'), 'module.exports = async (input, ctx) => { try { await ctx.ask(\'pick\', {}); return {output: {code: null}}; } catch (e) { if (e.code !== \'ASK_UNAVAILABLE\') throw e; return {output: {code: e.code}}; } };\n');
      fs.copyFileSync(path.join(mod, 'handlers', svc, 'askStuck.js'), path.join(mod, 'handlers', svc, 'askStuckTask.js'));
      fs.writeFileSync(path.join(mod, 'handlers', svc, 'all.js'), 'module.exports = async () => ({output: {ids: []}});\n');
      fs.writeFileSync(path.join(mod, 'handlers', svc, 'blank.js'), 'module.exports = async () => ({output: {}});\n');
      fs.writeFileSync(path.join(mod, 'handlers', svc, 'blob.js'), 'module.exports = async () => ({output: {file: Buffer.alloc(4096, 7).toString(\'base64\')}});\n');
      fs.writeFileSync(path.join(mod, 'handlers', svc, 'completeId.js'), `module.exports = async () => ({output: {values: ['i-1', 'i-${ZWSP}2', 'i-3']}});\n`);
      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'k', devices: ['*']}}));
      server = await startServer(PORT, ['--workerThread', '--store', 'local', '--storePath', path.join(dir, 'store'), '--moduleDataPath', path.join(dir, 'module_data'),
        '--authConfigPath', auth, '--inlineContentBytes', '1024', '--loadModule', mod]);
      for (let i = 0; i < 300; i++) {
        const listed = await modern('tools/list');
        if (listed.result != null && listed.result.tools.some((t) => /hidden_text_textservice_show$/.test(t.name))) return;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error(`the module never listed${log()}`);
    });
    after(() => {
      stopServer(server);
      if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    });

    it('tools/list: a tool\'s title and description', async () => {
      const tool = (await modern('tools/list')).result.tools.find((t) => /textservice_show$/.test(t.name));
      // a description keeps its \n and \t (the ruling's (2)); a title is one line
      assert.deepStrictEqual([tool.title, tool.description], ['Show  it', `Shows  a thing , ${FAMILY}.\nArgs:\twhat`]);
      // a description of hidden characters alone is none: the tool is not listed (#378's review (8))
      assert.ok(!(await modern('tools/list')).result.tools.some((t) => /textservice_blank$/.test(t.name)), 'a blank description was listed');
      // inside its schemas (register follow-up (3)): the input's text cleaned,
      // a hidden member, name or emptied enum left out; the output's text
      // cleaned, its data as declared (the client checks results against it)
      assert.strictEqual(tool.inputSchema.title, 'In put');
      assert.deepStrictEqual(Object.keys(tool.inputSchema.properties).sort(), ['mood', 'what']);
      assert.deepStrictEqual([tool.inputSchema.properties.what.description, tool.inputSchema.properties.mood.enum], ['What \nto show', ['calm']]);
      assert.deepStrictEqual([tool.outputSchema.title, tool.outputSchema.properties.status.enum], ['Out ', ['ok', `o${ZWSP}k`]]);
      // a required choice left with nothing: the tool is not listed
      assert.ok(!(await modern('tools/list')).result.tools.some((t) => /textservice_stuck$/.test(t.name)), 'a tool nothing can satisfy was listed');
      // and nothing else hidden anywhere in what was listed, but an output's data
      const tools = (await modern('tools/list')).result.tools.map((t) => {
        const c = Object.assign({}, t);
        if (c.outputSchema != null) c.outputSchema = JSON.parse(JSON.stringify(c.outputSchema, (k, v) => (['enum', 'const', 'default', 'examples'].includes(k) ? undefined : v)));
        return c;
      });
      clean(tools, 'tools/list');
    });

    it('a question\'s form: its text cleaned, a hidden member left out with its name; a required choice left with nothing, unavailable', async () => {
      const name = (await modern('tools/list')).result.tools.find((t) => /textservice_show$/.test(t.name)).name;
      const got = await modern('tools/call', {name, arguments: {what: 'it'}}, {elicitation: {form: {}}});
      const req = Object.values(got.result.inputRequests)[0];
      assert.deepStrictEqual(req.params.requestedSchema.properties.how, {type: 'string', title: 'How ', enum: ['now', 'soon'], enumNames: ['Now', 'So on']});
      clean(req, 'the form');
      // (a tool, so it is listed: its own input is plain)
      const stuck = (await modern('tools/list')).result.tools.find((t) => /textservice_askstuck$/.test(t.name)).name;
      // a call: the form is found unusable as the asking pass ends, and the
      // whole call answers ASK_UNAVAILABLE (the load warned its author)
      const asked = await modern('tools/call', {name: stuck, arguments: {}}, {elicitation: {form: {}}});
      assert.strictEqual(asked.result && asked.result.isError, true, JSON.stringify(asked).slice(0, 1500));
      assert.strictEqual(asked.result._meta['countinghouse/code'], 'ASK_UNAVAILABLE', JSON.stringify(asked).slice(0, 1500));
      // a task: its run starts again, and the handler's ctx.ask rejects
      // ASK_UNAVAILABLE, which it catches
      const TASKS = {extensions: {'io.modelcontextprotocol/tasks': {}}, elicitation: {form: {}}};
      const inTask = (await modern('tools/list')).result.tools.find((t) => /textservice_askstucktask$/.test(t.name)).name;
      const made = await modern('tools/call', {name: inTask, arguments: {}}, TASKS);
      assert.strictEqual(made.result && made.result.resultType, 'task', JSON.stringify(made).slice(0, 800));
      let task = null;
      for (let i = 0; i < 200; i++) {
        task = (await modern('tasks/get', {taskId: made.result.taskId}, TASKS)).result;
        if (task != null && task.status !== 'working') break;
        await new Promise((res) => setTimeout(res, 50));
      }
      assert.strictEqual(task.status, 'completed', JSON.stringify(task).slice(0, 800));
      assert.strictEqual(task.result.structuredContent.code, 'ASK_UNAVAILABLE', JSON.stringify(task).slice(0, 800));
    });

    it('the load\'s check warns of each: what is left out, what is unavailable, an output\'s data, an unknown keyword\'s text', () => {
      const checked = require('../../lib/declarations').check(JSON.parse(fs.readFileSync(path.join(dir, 'hidden-text', 'api.json'), 'utf8')),
        JSON.parse(fs.readFileSync(path.join(dir, 'hidden-text', 'schema.json'), 'utf8')));
      const said = checked.warnings.map((w) => w.message).join('\n');
      assert.match(said, /show input.*mood.*hidden character.*left out/);
      assert.match(said, /stuck input.*mode.*hidden character.*not listed/);
      assert.match(said, /askStuck questions\.pick.*hidden character.*unavailable/);
      assert.match(said, /show output.*status.*hidden character.*as declared/);
      assert.match(said, /stuck input.*x-label.*hidden character/);
    });

    it('prompts/list and prompts/get: title, description, an argument\'s description, the messages (\\n and \\t kept); the client\'s argument as it sent it', async () => {
      const listed = (await modern('prompts/list')).result.prompts.find((p) => /greet$/.test(p.name));
      assert.deepStrictEqual([listed.title, listed.description, listed.arguments[0].description], ['Greet ', 'Says  hello', 'Who  to greet\nby name']);
      const got = await modern('prompts/get', {name: listed.name, arguments: {who: 'ann'}});
      // prompts/get's description is cleaned too (#378's review (1))
      assert.strictEqual(got.result.description, 'Says  hello', JSON.stringify(got));
      clean(got.result, 'prompts/get');
      assert.strictEqual(got.result.messages[0].content.text, `Hello ann !\nLine two\tends ${FAMILY} ${HEART} a${ZWJ}b 1 2`, JSON.stringify(got));
      clean((await modern('prompts/list')).result, 'prompts/list');
    });

    it('resources/list and resources/templates/list: title and description (a name is an identifier, by the meta-schema)', async () => {
      const r = (await modern('resources/list')).result.resources.find((x) => /items$/.test(x.uri));
      assert.deepStrictEqual([r.name, r.title], ['items', 'All  items']);
      const t = (await modern('resources/templates/list')).result.resourceTemplates.find((x) => /items\/\{id\}$/.test(x.uriTemplate));
      assert.deepStrictEqual([t.name, t.title, t.description], ['item', 'An  item', 'One  item.\nBy id.']);
      clean((await modern('resources/list')).result, 'resources/list');
      clean((await modern('resources/templates/list')).result, 'resources/templates/list');
    });

    it('completion: a candidate with a hidden character is left out, never changed', async () => {
      const name = (await modern('prompts/list')).result.prompts.find((p) => /greet$/.test(p.name)).name;
      const got = await modern('completion/complete', {ref: {type: 'ref/prompt', name}, argument: {name: 'who', value: ''}});
      assert.deepStrictEqual(got.result.completion.values, ['ann', 'bea'], JSON.stringify(got));
    });

    it('completion: a completion action\'s value with a hidden character is left out too (M11)', async () => {
      const got = await modern('completion/complete', {ref: {type: 'ref/resource', uri: 'countinghouse://m/hidden_text/items/{id}'}, argument: {name: 'id', value: 'i'}});
      assert.deepStrictEqual(got.result.completion.values, ['i-1', 'i-3'], JSON.stringify(got));
    });

    // the ruling's (3): its name goes back from the client, so it can't be
    // cleaned; the prompt is left out, and the load's warning names it
    it('a prompt whose argument\'s name has a hidden character is left out: not listed, unknown to prompts/get; the load warns', async () => {
      const prompts = (await modern('prompts/list')).result.prompts;
      assert.ok(!prompts.some((p) => /sneaky$/.test(p.name)), JSON.stringify(prompts.map((p) => p.name)));
      const got = await modern('prompts/get', {name: 'hidden_text_sneaky', arguments: {}});
      assert.ok(got.error != null && /unknown prompt/.test(got.error.message), JSON.stringify(got));
      // the load's check says why (as validate reports it)
      const checked = require('../../lib/declarations').check(JSON.parse(fs.readFileSync(path.join(dir, 'hidden-text', 'api.json'), 'utf8')),
        JSON.parse(fs.readFileSync(path.join(dir, 'hidden-text', 'schema.json'), 'utf8')));
      assert.ok(checked.warnings.some((w) => /sneaky.*is named with a hidden character, so the prompt is not listed/.test(w.message)), JSON.stringify(checked.warnings));
    });

    // #378's review (4): a linked value's block carries its field's
    // description, which is declared text too
    it('a resource_link block\'s description', async () => {
      const name = (await modern('tools/list')).result.tools.find((t) => /textservice_blob$/.test(t.name)).name;
      const got = await modern('tools/call', {name, arguments: {}});
      const link = (got.result.content || []).find((b) => b.type === 'resource_link');
      assert.ok(link != null, JSON.stringify(got).slice(0, 800));
      assert.strictEqual(link.description, 'Report  file');
      clean(got.result, 'tools/call');
    });

    it('a question\'s dialog text', async () => {
      const name = (await modern('tools/list')).result.tools.find((t) => /textservice_show$/.test(t.name)).name;
      const got = await modern('tools/call', {name, arguments: {what: `the${ZWSP} thing`}}, {elicitation: {form: {}}});
      assert.strictEqual(got.result && got.result.resultType, 'input_required', JSON.stringify(got) + log());
      const req = Object.values(got.result.inputRequests)[0];
      assert.strictEqual(req.params.message, 'hidden-text: Go  on with the  thing?');
    });
  });
});
