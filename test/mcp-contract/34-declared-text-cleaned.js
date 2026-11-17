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
      .set(typeof(params.name) === 'string' ? {'Mcp-Name': params.name} : {})
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
        [svc]: {show: {input: {type: 'object', properties: {what: {type: 'string'}}}, output: {type: 'object'},
          questions: {confirm: {type: 'object', properties: {yes: {type: 'boolean', title: 'Yes'}}, required: ['yes']}}},
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
      // (text inside an advertised input or output schema is not cleaned in
      // this release: stated in #378; the blob's field description has one)
      const tools = (await modern('tools/list')).result.tools.map((t) => { const c = Object.assign({}, t); delete c.inputSchema; delete c.outputSchema; return c; });
      clean(tools, 'tools/list');
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
