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
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

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

  // lib/declarations.js: (api.json, schema.json) -> problems and warnings.
  // Pure, bounded, and tolerant of a spec the meta-schema would refuse
  // (which is reported by the meta-schema, not here).
  describe('what a schema cannot say (lib/declarations.js)', () => {
    const declarations = require('../../lib/declarations');
    const PNG = {type: 'string', contentEncoding: 'base64', contentMediaType: 'image/png'};
    const obj = (properties, more = {}) => Object.assign({type: 'object', properties}, more);
    // one action over a schema.json of its own
    const checked = ({action = {}, input = obj({}), output = obj({}), schema = {}, device = {}} = {}) => declarations.check(specOf(action, device),
      Object.assign({notesService: {readNote: {input, output}}}, schema));
    const messages = (r) => r.problems.map((p) => p.message);
    const clean = (r, what) => assert.deepStrictEqual(messages(r), [], what);
    const one = (r, pattern, what) => {
      assert.strictEqual(r.problems.length, 1, `${what}: ${JSON.stringify(messages(r))}`);
      assert.match(r.problems[0].message, pattern, what);
      return r.problems[0];
    };

    it('a module that declares nothing new has no problem and no warning', () => {
      assert.deepStrictEqual(checked(), {problems: [], warnings: []});
      // nor does one with no schema.json at all, or a spec that is not one
      assert.deepStrictEqual(declarations.check(specOf(), null), {problems: [], warnings: []});
      for (const junk of [null, 7, 'x', {}, {device: null}, {device: {serviceList: 7}}, {device: {serviceList: {[SERVICE]: {actionList: 'x'}}}}]) {
        assert.deepStrictEqual(declarations.check(junk, {}), {problems: [], warnings: []}, JSON.stringify(junk));
      }
    });

    describe('a binary output field (section 1)', () => {
      it('may sit under properties and array items, to 8 levels, or be the whole output', () => {
        clean(checked({output: obj({image: PNG, pages: {type: 'array', items: PNG}, nested: obj({thumb: PNG})})}), 'properties and items');
        clean(checked({output: PNG}), 'the whole output');
        clean(checked({output: {type: 'array', items: obj({shot: PNG})}}), 'an array of objects');
        let deep = PNG;
        for (let i = 0; i < 8; i++) deep = obj({d: deep});
        clean(checked({output: deep}), 'eight levels down');
      });

      it('anywhere else is a problem that says where, and to declare it under properties or items', () => {
        const elsewhere = {
          oneOf: {oneOf: [obj({image: PNG}), obj({})]},
          anyOf: {anyOf: [obj({image: PNG})]},
          allOf: {allOf: [obj({image: PNG})]},
          if: obj({}, {if: obj({image: PNG})}),
          then: obj({}, {if: obj({}), then: obj({image: PNG})}),
          else: obj({}, {if: obj({}), else: obj({image: PNG})}),
          not: obj({}, {not: obj({image: PNG})}),
          patternProperties: obj({}, {patternProperties: {'^img': PNG}}),
          additionalProperties: obj({}, {additionalProperties: PNG}),
          prefixItems: {type: 'array', prefixItems: [PNG]},
          dependentSchemas: obj({}, {dependentSchemas: {a: obj({image: PNG})}}),
          $defs: obj({}, {$defs: {image: PNG}})
        };
        for (const [where, output] of Object.entries(elsewhere)) {
          const p = one(checked({output}), /binary field .* declare it inline, under properties or items/, where);
          assert.ok(p.message.includes(where), `${where}: ${p.message}`);
          assert.match(p.path, /notesService\.readNote/);
        }
      });

      it('a binary field reached through $ref counts as elsewhere, wherever the $ref points (the reviewer\'s ruling in M3)', () => {
        one(checked({output: obj({image: {$ref: '#/shared/image'}}), schema: {shared: {image: PNG}}}), /\$ref.*declare it inline, under properties or items/, 'a $ref out of the action\'s schema');
        one(checked({output: obj({image: {$ref: '#/notesService/readNote/output/$defs/image'}}, {$defs: {image: PNG}})}), /declare it inline/, 'a $ref into its own $defs');
        one(checked({output: {$ref: '#/shared/whole'}, schema: {shared: {whole: obj({image: PNG})}}}), /\$ref/, 'the whole output a $ref');
        // a $ref that leads to no binary field is no problem, and a loop of them ends
        clean(checked({output: obj({meta: {$ref: '#/shared/meta'}}), schema: {shared: {meta: obj({n: {type: 'integer'}})}}}));
        clean(checked({output: obj({node: {$ref: '#/shared/node'}}), schema: {shared: {node: obj({next: {$ref: '#/shared/node'}})}}}));
      });

      it('the message names the keyword it sits under, also past an array\'s items and for a field named like a keyword', () => {
        // items, then properties, then anyOf: "anyOf" is what is wrong, not a property's name
        const p = one(checked({output: {type: 'array', items: obj({shot: {anyOf: [PNG]}})}}), /is under anyOf/, 'items/properties/anyOf');
        assert.ok(!/is under shot/.test(p.message));
        // a binary property named "oneOf", under properties, is a mapped field like any other
        clean(checked({output: obj({oneOf: PNG, default: PNG, items: PNG})}), 'fields named like keywords');
        // and one under a property named "default" that sits under oneOf is found
        one(checked({output: obj({}, {oneOf: [obj({default: PNG})]})}), /is under oneOf/, 'a field named default under oneOf');
      });

      // /code-review of #302, 1: the runtime dereferences schema.json before the gateway maps the fields, so a
      // $ref to a field that is ALSO declared inline would be mapped a second time
      it('a $ref that leads to a binary field is a problem also when that field is declared inline elsewhere (an alias)', () => {
        const alias = one(checked({output: obj({a: PNG, b: {$ref: '#/notesService/readNote/output/properties/a'}})}), /reached through a \$ref.*declare it inline/, 'an alias of an inline field');
        assert.ok(alias.message.includes('/properties/b'), alias.message);
        // an alias of an object that holds one
        one(checked({output: obj({w: obj({img: PNG}), again: {$ref: '#/notesService/readNote/output/properties/w'}})}), /\/properties\/again.*reached through a \$ref/, 'an alias of its parent');
        // two aliases: each $ref is said
        const twice = checked({output: obj({a: PNG, b: {$ref: '#/notesService/readNote/output/properties/a'}, c: {$ref: '#/notesService/readNote/output/properties/a'}})});
        assert.strictEqual(twice.problems.length, 2, JSON.stringify(messages(twice)));
        // sixteen inline and one alias is not "sixteen": it is refused
        const sixteen = Object.fromEntries(Array.from({length: 16}, (x, i) => [`f${i}`, PNG]));
        one(checked({output: obj(Object.assign({}, sixteen, {more: {$ref: '#/notesService/readNote/output/properties/f0'}}))}), /reached through a \$ref/, 'sixteen and an alias');
      });

      it('an items that is a list of schemas is said as that, not as too deep (/code-review of #302, 6)', () => {
        const p = one(checked({output: {type: 'array', items: [PNG]}}), /items that is a list of schemas/, 'a tuple-form items');
        assert.ok(!/deeper than/.test(p.message), p.message);
      });

      it('the mapped nodes are the gateway\'s own (binary-fields\' binaryNodes): one walk, not a copy of it', () => {
        const binary = require('../../lib/binary-fields');
        const output = obj({image: PNG, pages: {type: 'array', items: PNG}, nested: obj({thumb: PNG}), under: {oneOf: [PNG]}});
        const nodes = binary.binaryNodes(output);
        assert.deepStrictEqual(nodes, [output.properties.image, output.properties.pages.items, output.properties.nested.properties.thumb]);
        assert.strictEqual(nodes.length, binary.binaryFields(output).length);
      });

      it('a $ref is followed as the runtime resolves one (lib/schema-safety.js): a $dynamicRef to an anchor, a pointer with an escaped token', () => {
        one(checked({output: obj({image: {$dynamicRef: '#img'}}), schema: {shared: {anyImage: Object.assign({$dynamicAnchor: 'img'}, PNG)}}}), /\$ref.*declare it inline/, 'a $dynamicRef to a $dynamicAnchor');
        one(checked({output: obj({image: {$ref: '#/shared/a~1b'}}), schema: {shared: {'a/b': PNG}}}), /\$ref.*declare it inline/, 'a ~1 token');
        one(checked({output: obj({image: {$ref: '#/shared/a%20b'}}), schema: {shared: {'a b': PNG}}}), /\$ref.*declare it inline/, 'a percent-encoded token');
        // an action's own pointer too: "#" + pointer, decoded per token
        const spec = specOf({output: {schema: '/notesService/read%20note/output'}});
        one(declarations.check(spec, {notesService: {'read note': {output: obj({}, {oneOf: [obj({image: PNG})]})}}}), /is under oneOf/, 'a percent-encoded action pointer');
      });

      it('the walk is bounded on its own: a schema.json whose actions come to more nodes than the load would ever let through is one problem', function() {
        this.timeout(30000);
        // each action's output is one schema of 20,000 nodes: MAX_VISITS is passed at some action, and the walks stop there
        const big = obj(Object.fromEntries(Array.from({length: 20000}, (x, i) => [`p${i}`, {type: 'string'}])));
        const spec = specOf();
        const actions = Math.ceil(declarations.MAX_VISITS / 20000) + 2;
        spec.device.serviceList[SERVICE].actionList = Array.from({length: actions}, (x, i) => ({name: `a${i}`, description: 'x', output: {schema: '/shared/big'}}));
        const r = declarations.check(spec, {shared: {big: big}});
        assert.strictEqual(r.problems.length, 1, JSON.stringify(messages(r).slice(0, 3)));
        assert.match(r.problems[0].message, /schema\.json is too large for its declarations to be checked/);
        // under it, the same schema is nothing
        spec.device.serviceList[SERVICE].actionList.length = 3;
        clean(declarations.check(spec, {shared: {big: big}}));
        // a schema nested past the stack is the same problem, not a throw
        let deep = {type: 'string'};
        for (let i = 0; i < 200000; i++) deep = {not: deep};
        one(checked({output: deep}), /too large for its declarations to be checked.*nested too deeply/, 'nested past the stack');
      });

      it('more than 8 levels down, or with a union type, is elsewhere too', () => {
        let deep = PNG;
        for (let i = 0; i < 9; i++) deep = obj({d: deep});
        one(checked({output: deep}), /deeper than 8 levels/, 'nine levels');
        one(checked({output: obj({image: {type: ['string', 'null'], contentEncoding: 'base64', contentMediaType: 'image/png'}})}), /type is exactly "string"/, 'a union type');
      });

      it('at most 16 a action, each with a media type of the form type/subtype', () => {
        const many = (n) => obj(Object.fromEntries(Array.from({length: n}, (x, i) => [`f${i}`, PNG])));
        clean(checked({output: many(16)}));
        one(checked({output: many(17)}), /17 binary fields.*at most 16/, 'seventeen');
        for (const bad of ['png', 'image/', '/png', 'image/png; charset=binary', 'image/p ng', '', 7, null, ['image/png']]) {
          one(checked({output: obj({image: {type: 'string', contentEncoding: 'base64', contentMediaType: bad}})}), /not a media type of the form type\/subtype/, JSON.stringify(bad));
        }
      });

      it('what is not a binary field is left alone: base64 with no media type, a media type with no encoding, a look-alike inside default or examples, an input', () => {
        clean(checked({output: obj({raw: {type: 'string', contentEncoding: 'base64'}}, {oneOf: [obj({raw: {type: 'string', contentEncoding: 'base64'}})]})}));
        clean(checked({output: obj({text: {type: 'string', contentMediaType: 'text/html'}})}));
        clean(checked({output: obj({note: {type: 'object', default: PNG, examples: [PNG], const: PNG, enum: [PNG]}})}));
        // an input's binary argument is validated wherever it sits; the map is the output's
        clean(checked({input: obj({}, {oneOf: [obj({image: PNG})]})}));
      });
    });

    describe('x-mcp-header (section 4)', () => {
      it('anywhere in an input schema is a problem: the keyword is refused until the server\'s side is designed', () => {
        const header = {type: 'string', 'x-mcp-header': 'X-Region'};
        const places = {
          'a property': obj({region: header}),
          'a nested property': obj({where: obj({region: header})}),
          'under oneOf': obj({}, {oneOf: [obj({region: header})]}),
          'in $defs': obj({}, {$defs: {region: header}}),
          'through a $ref': obj({region: {$ref: '#/shared/region'}})
        };
        for (const [where, input] of Object.entries(places)) {
          const p = one(checked({input, schema: {shared: {region: header}}}), /x-mcp-header is not served/, where);
          assert.match(p.path, /notesService\.readNote input/);
        }
      });

      it('a property that is NAMED default, enum, const or examples is a property like any other: the keyword is found inside it', () => {
        const header = {type: 'string', 'x-mcp-header': 'X-Region'};
        for (const name of ['default', 'enum', 'const', 'examples']) {
          one(checked({input: obj({[name]: header})}), /x-mcp-header is not served/, `a property named ${name}`);
          one(checked({input: obj({outer: obj({[name]: obj({region: header})})})}), /x-mcp-header is not served/, `nested under a property named ${name}`);
          one(checked({input: obj({}, {$defs: {[name]: header}})}), /x-mcp-header is not served/, `a $defs entry named ${name}`);
        }
      });

      it('a value that only looks like it (inside default, examples, enum or const) is data, and an output is not an input', () => {
        clean(checked({input: obj({note: {type: 'object', default: {'x-mcp-header': 'X'}, examples: [{'x-mcp-header': 'X'}]}})}));
        clean(checked({output: obj({region: {type: 'string', 'x-mcp-header': 'X-Region'}})}));
      });
    });

    // a module with more than the one action: save and the completion action
    const STR = {type: 'string'};
    const withActions = ({action = {}, input = obj({id: STR}, {required: ['id']}), output = obj({}), extra = [], schema = {}, device = {}} = {}) => {
      const spec = specOf(action, device);
      spec.device.serviceList[SERVICE].actionList.push({name: 'save', description: 'Saves.'}, {name: 'completeId', description: 'Completes an id.',
        input: {schema: '/notesService/completeId/input'}, output: {schema: '/notesService/completeId/output'}}, ...extra);
      return declarations.check(spec, Object.assign({notesService: {readNote: {input, output},
        completeId: {input: obj({argument: STR, value: STR, context: {type: 'object'}}, {required: ['argument', 'value']}), output: obj({values: {type: 'array', items: STR}}, {required: ['values']})}}}, schema));
    };
    const RESOURCE = {uriTemplate: 'notes/{id}', name: 'note'};

    describe('a resource (section 3)', () => {
      it('its template is a relative path of literals and {name}: at most 8 variables, none twice, no scheme, no empty, dot or dot-dot segment', () => {
        clean(withActions({action: {resource: RESOURCE}}));
        clean(withActions({action: {resource: {uriTemplate: 'index', name: 'index'}}, input: obj({})}), 'a static resource');
        clean(withActions({action: {resource: {uriTemplate: 'a/{x}/b/{y}.md', name: 'n'}}, input: obj({x: STR, y: STR}, {required: ['x', 'y']})}));
        for (const bad of ['/notes/{id}', 'notes/{id}/', 'notes//{id}', '../notes/{id}', 'notes/./{id}', 'notes/../{id}', 'https://example.com/{id}', 'countinghouse://m/x/{id}',
          'notes/{id', 'notes/id}', 'notes/{}', 'notes/{i d}', 'notes/{+id}', 'notes/{id*}', 'notes/{id,name}', 'notes/{id:3}', 'notes/{?id}', 'notes/{id}?x=1', 'notes/{id}#frag', 'no tes/{id}', 'notes/%zz/{id}']) {
          one(withActions({action: {resource: {uriTemplate: bad, name: 'note'}}}), /uriTemplate/, bad);
        }
        one(withActions({action: {resource: {uriTemplate: 'n/{id}/{id}', name: 'note'}}}), /uriTemplate.*twice/, 'a variable twice');
        const nine = Array.from({length: 9}, (x, i) => `v${i}`);
        one(withActions({action: {resource: {uriTemplate: nine.map((v) => `{${v}}`).join('/'), name: 'note'}},
          input: obj(Object.fromEntries(nine.map((v) => [v, STR])), {required: nine})}), /at most 8 variables/, 'nine variables');
      });

      it('each variable is a string property of the action\'s input, and every required input is a variable', () => {
        one(withActions({action: {resource: RESOURCE}, input: obj({name: STR})}), /variable \{id\} is not a property of its input/, 'a variable the input does not have');
        one(withActions({action: {resource: RESOURCE}, input: obj({id: {type: 'integer'}}, {required: ['id']})}), /variable \{id\}.*type "string"/, 'a variable that is no string');
        one(withActions({action: {resource: RESOURCE}, input: obj({id: {type: ['string', 'null']}})}), /variable \{id\}.*type "string"/, 'a union type');
        one(withActions({action: {resource: RESOURCE}, input: obj({id: STR, lang: STR}, {required: ['id', 'lang']})}), /required input "lang" is not a variable/, 'a required input a read could never give');
        clean(withActions({action: {resource: RESOURCE}, input: obj({id: STR, lang: STR}, {required: ['id']})}), 'an optional input that is no variable');
        one(withActions({action: {resource: {uriTemplate: 'index', name: 'index'}}, input: obj({id: STR}, {required: ['id']})}), /required input "id" is not a variable/, 'a static resource with a required input');
        one(withActions({action: {resource: RESOURCE}, input: {type: 'array'}}), /input is not an object schema/, 'an input that is no object');
        // an input schema that is only a $ref to one is read through it
        clean(withActions({action: {resource: RESOURCE}, input: {$ref: '#/shared/byId'}, schema: {shared: {byId: obj({id: STR}, {required: ['id']})}}}));
      });

      // /code-review of #302, 2 and 3: the runtime dereferences, so a variable's schema may be a $ref, alone or
      // beside other keywords, and so may the input's root
      it('a variable, and the input itself, may be declared through a $ref, with or without keywords beside it', () => {
        const shared = {shared: {noteId: {type: 'string', maxLength: 64}, byId: obj({id: STR}, {required: ['id']}), count: {type: 'integer'}, chain: {$ref: '#/shared/noteId'}}};
        clean(withActions({action: {resource: RESOURCE}, input: obj({id: {$ref: '#/shared/noteId'}}, {required: ['id']}), schema: shared}), 'a $ref alone');
        clean(withActions({action: {resource: RESOURCE}, input: obj({id: {$ref: '#/shared/noteId', description: 'The id.'}}, {required: ['id']}), schema: shared}), 'a $ref with a description');
        clean(withActions({action: {resource: RESOURCE}, input: obj({id: {$ref: '#/shared/chain'}}, {required: ['id']}), schema: shared}), 'a chain of two');
        clean(withActions({action: {resource: RESOURCE}, input: {$ref: '#/shared/byId', description: 'By id.'}, schema: shared}), 'the root, with a keyword beside it');
        // properties on both sides of a root $ref are all the input's
        clean(withActions({action: {resource: {uriTemplate: 'notes/{id}/{lang}', name: 'note'}}, input: {$ref: '#/shared/byId', properties: {lang: STR}, required: ['lang']}, schema: shared}), 'properties beside the $ref');
        one(withActions({action: {resource: RESOURCE}, input: {$ref: '#/shared/byId', properties: {lang: STR}, required: ['lang']}, schema: shared}), /required input "lang" is not a variable/, 'a required input beside the $ref');
        one(withActions({action: {resource: RESOURCE}, input: obj({id: {$ref: '#/shared/count'}}, {required: ['id']}), schema: shared}), /variable \{id\}.*type "string"/, 'a $ref to an integer');
        one(withActions({action: {resource: RESOURCE}, input: obj({id: {$ref: '#/shared/nowhere'}}, {required: ['id']}), schema: shared}), /variable \{id\}.*type "string"/, 'a $ref to nothing');
      });

      // /code-review of #302, 4: a variable matches one segment's characters, so templates are compared segment by segment
      it('two templates that some URI matches both are a problem, whatever their shapes; a segment holds at most one variable', () => {
        const pair = (a, b) => {
          const spec = specOf({resource: {uriTemplate: a, name: 'first'}});
          spec.device.serviceList[SERVICE].actionList.push({name: 'second', description: 'x', resource: {uriTemplate: b, name: 'second'}});
          return declarations.check(spec, {notesService: {readNote: {input: obj({id: STR, x: STR, y: STR}), output: obj({})}}})
            .problems.filter((p) => /same URIs/.test(p.message));
        };
        for (const [a, b] of [['notes/{id}', 'notes/all'], ['notes/all', 'notes/{id}'], ['files/{x}.json', 'files/{y}'], ['files/{x}.json', 'files/a{y}'], ['v{x}/n', '{y}/n'], ['notes/{id}', 'notes/{x}']]) {
          assert.strictEqual(pair(a, b).length, 1, `${a} and ${b}`);
        }
        for (const [a, b] of [['notes/{id}', 'tags/{id}'], ['notes/{id}', 'notes/{id}/raw'], ['files/{x}.json', 'files/{y}.md'], ['a{x}', 'b{y}'], ['notes/all', 'notes/none']]) {
          assert.deepStrictEqual(pair(a, b), [], `${a} and ${b}`);
        }
        // a segment that would be . or .. with its variable empty
        for (const bad of ['notes/.{x}', 'notes/{x}.', 'notes/..{x}', '{x}../n']) {
          one(withActions({action: {resource: {uriTemplate: bad, name: 'n'}}, input: obj({x: STR}, {required: ['x']})}), /uriTemplate.*\. or \.\./, bad);
        }
        // two variables in one segment cannot be read back from a URI
        for (const bad of ['{x}-{y}', '{x}{y}', 'notes/{x}.{y}']) {
          one(withActions({action: {resource: {uriTemplate: bad, name: 'n'}}, input: obj({x: STR, y: STR}, {required: ['x', 'y']})}), /uriTemplate.*at most one variable in a segment/, bad);
        }
      });

      it('no two resources of a module match the same URIs', () => {
        const other = {name: 'readOther', description: 'Another.', resource: {uriTemplate: 'notes/{key}', name: 'other'}, input: {schema: '/notesService/readOther/input'}};
        const r = withActions({action: {resource: RESOURCE}, extra: [other], schema: {notesService2: {}}, device: {}});
        // (readOther's input is not in schema.json here: the template clash is what is checked)
        assert.ok(messages(r).some((m) => /notes\/\{key\}.*same URIs as.*notes\/\{id\}/.test(m)), JSON.stringify(messages(r)));
      });

      it('changesWith and completion name actions of this module; a completion is for one of its variables', () => {
        clean(withActions({action: {resource: Object.assign({changesWith: ['notesService.save'], completion: {id: 'notesService.completeId'}}, RESOURCE)}}));
        one(withActions({action: {resource: Object.assign({changesWith: ['notesService.gone']}, RESOURCE)}}), /changesWith names notesService\.gone, which is no action of this module/, 'an unknown action');
        one(withActions({action: {resource: Object.assign({changesWith: ['other.save']}, RESOURCE)}}), /changesWith names other\.save/, 'another service');
        one(withActions({action: {resource: Object.assign({completion: {name: 'notesService.completeId'}}, RESOURCE)}}), /completion is for "name", which is not a variable/, 'not a variable');
        one(withActions({action: {resource: Object.assign({completion: {id: 'notesService.gone'}}, RESOURCE)}}), /completion names notesService\.gone, which is no action/, 'an unknown completion action');
      });

      it('a resource action is not long-running', () => {
        one(withActions({action: {resource: RESOURCE, longRunning: true}}), /a resource is read in one answer: longRunning/, 'longRunning on a resource');
        clean(withActions({action: {resource: RESOURCE, longRunning: false}}));
      });
    });

    describe('a completion action (section 7)', () => {
      const completing = (input, output) => withActions({action: {resource: Object.assign({completion: {id: 'notesService.completeId'}}, RESOURCE)},
        schema: {notesService: {readNote: {input: obj({id: STR}, {required: ['id']}), output: obj({})}, completeId: {input, output}}}});
      const IN = obj({argument: STR, value: STR, context: {type: 'object'}}, {required: ['argument', 'value']});
      const OUT = obj({values: {type: 'array', items: STR}}, {required: ['values']});

      it('takes {argument, value, context} and gives {values: string[]}: both shapes are fixed', () => {
        clean(completing(IN, OUT));
        clean(completing(obj({argument: STR, value: STR}), OUT), 'context is optional to declare');
        one(completing(obj({argument: STR}), OUT), /completeId.*input.*\{argument, value, context\}/, 'no value');
        one(completing(obj({argument: STR, value: {type: 'integer'}}), OUT), /completeId.*input/, 'a value that is no string');
        one(completing(obj({argument: STR, value: STR, more: STR}, {required: ['more']}), OUT), /completeId.*input/, 'another required input');
        one(completing(IN, obj({values: {type: 'array', items: {type: 'integer'}}})), /completeId.*output.*\{values: string\[\]\}/, 'values that are no strings');
        one(completing(IN, obj({items: {type: 'array', items: STR}})), /completeId.*output/, 'no values');
        one(completing(IN, {type: 'array', items: STR}), /completeId.*output/, 'an output that is no object');
      });
    });

    describe('a prompt (section 7)', () => {
      const PROMPT = {name: 'triage', description: 'Asks for a triage.', arguments: {schema: '/prompts/triage/arguments'}, messages: [{role: 'user', text: 'Triage run {{run}} of {{repo}}.'}]};
      const ARGS = obj({run: STR, repo: STR}, {required: ['run']});
      const prompts = (list, args = ARGS) => withActions({device: {promptList: list}, schema: {prompts: {triage: {arguments: args}}}});

      it('its arguments are an object schema of string properties, at most 16; a required one is one of them', () => {
        clean(prompts([PROMPT]));
        clean(prompts([{name: 'plain', messages: [{role: 'user', text: 'No arguments at all.'}]}]));
        one(prompts([PROMPT], obj({run: {type: 'integer'}, repo: STR})), /argument "run" is not of type "string"/, 'an integer argument');
        one(prompts([PROMPT], {type: 'array'}), /arguments is not an object schema/, 'no object');
        one(prompts([PROMPT], obj(Object.fromEntries([['run', STR], ['repo', STR]].concat(Array.from({length: 15}, (x, i) => [`a${i}`, STR]))))), /17 arguments.*at most 16/, 'seventeen');
        one(prompts([PROMPT], obj({run: STR, repo: STR}, {required: ['run', 'branch']})), /required argument "branch" is not one of its properties/, 'a required one it does not have');
        one(prompts([Object.assign({}, PROMPT, {arguments: {schema: '/prompts/none/arguments'}})]), /arguments points to \/prompts\/none\/arguments, which is not in schema\.json/, 'a pointer to nothing');
      });

      it('every {{name}} in its messages is one of its arguments; its text is at most 8 KiB', () => {
        one(prompts([Object.assign({}, PROMPT, {messages: [{role: 'user', text: 'Triage {{run}} on {{branch}}.'}]})]), /\{\{branch\}\} is not one of its arguments/, 'an unknown placeholder');
        one(prompts([{name: 'plain', messages: [{role: 'user', text: 'Hello {{who}}.'}]}]), /\{\{who\}\} is not one of its arguments/, 'a placeholder with no arguments');
        clean(prompts([Object.assign({}, PROMPT, {messages: [{role: 'user', text: 'A single {brace}, a {{ spaced }} one and an }} are text.'}]})]));
        // 8 KiB is bytes: 3000 three-byte characters are within the schema's 8192 characters and over it
        one(prompts([Object.assign({}, PROMPT, {messages: [{role: 'user', text: '\u4e2d'.repeat(3000)}]})]), /text is 9000 bytes.*at most 8192/, 'bytes, not characters');
      });

      it('an argument may be declared through a $ref; so may the arguments schema, and a completion action\'s fields', () => {
        const shared = {shared: {name: {type: 'string', maxLength: 64}, args: obj({run: STR, repo: STR}, {required: ['run']})}};
        clean(withActions({device: {promptList: [PROMPT]}, schema: Object.assign({prompts: {triage: {arguments: obj({run: {$ref: '#/shared/name'}, repo: {$ref: '#/shared/name', description: 'The repository.'}})}}}, shared)}));
        clean(withActions({device: {promptList: [PROMPT]}, schema: Object.assign({prompts: {triage: {arguments: {$ref: '#/shared/args', description: 'x'}}}}, shared)}));
        clean(withActions({action: {resource: Object.assign({completion: {id: 'notesService.completeId'}}, RESOURCE)},
          schema: Object.assign({notesService: {readNote: {input: obj({id: STR}, {required: ['id']}), output: obj({})},
            completeId: {input: obj({argument: {$ref: '#/shared/name'}, value: {$ref: '#/shared/name'}}), output: obj({values: {type: 'array', items: {$ref: '#/shared/name'}}})}}}, shared)}));
      });

      // /code-review of #302, 5: text in double braces that is no placeholder is sent as written; said, since it is likely a slip
      it('double braces that are not a placeholder, and an argument no placeholder can name, are warnings', () => {
        const warned = (text, args = ARGS) => prompts([Object.assign({}, PROMPT, {messages: [{role: 'user', text}]})], args);
        for (const text of ['Triage {{ run }}.', 'Triage {{run name}}.', 'Triage {{}}.', 'Triage {{run}} and {{r\u00e9}}.']) {
          const r = warned(text);
          clean(r, text);
          assert.strictEqual(r.warnings.length, 1, `${text}: ${JSON.stringify(r.warnings)}`);
          assert.match(r.warnings[0].message, /is not a placeholder.*sent as written/);
        }
        assert.strictEqual(warned('Triage {{run}} of {{repo}}; a ${{ secrets.X }} is one such too.').warnings.length, 1);
        assert.deepStrictEqual(warned('Triage {{run}} of {{repo}}. A {single} brace and a lone }} are text.').warnings, []);
        const odd = warned('Triage {{run}}.', obj({run: STR, 'run name': STR}));
        clean(odd);
        assert.match(odd.warnings[0].message, /argument "run name" can never be named in a message/);
      });

      it('names are not used twice; a completion is for one of its arguments, by an action of this module', () => {
        one(prompts([PROMPT, Object.assign({}, PROMPT)]), /promptList names "triage" twice/, 'a name twice');
        clean(prompts([Object.assign({completion: {repo: 'notesService.completeId'}}, PROMPT)]));
        one(prompts([Object.assign({completion: {branch: 'notesService.completeId'}}, PROMPT)]), /completion is for "branch", which is not one of its arguments/, 'not an argument');
        one(prompts([Object.assign({completion: {repo: 'notesService.gone'}}, PROMPT)]), /completion names notesService\.gone, which is no action/, 'an unknown action');
      });
    });

    describe('a question (section 8)', () => {
      const Q = {overwrite: {message: 'Replace the saved note {name}?', schema: '/notesService/readNote/questions/overwrite'}};
      const asking = (form, questions = Q) => {
        const r = declarations.check(specOf({questions}), {notesService: {readNote: {input: obj({}), output: obj({}), questions: {overwrite: form}}}});
        return r;
      };
      const FORM = obj({approve: {type: 'boolean', title: 'Approve'}, reason: {type: 'string', maxLength: 200}, count: {type: 'integer', minimum: 0}, ratio: {type: 'number'},
        mode: {type: 'string', enum: ['fast', 'safe']}}, {required: ['approve']});

      it('its schema is a flat form: an object of string, number, integer, boolean and enum properties, at most 8', () => {
        clean(asking(FORM));
        one(asking({type: 'array'}), /is not a flat form: an object schema/, 'no object');
        one(asking(obj({nested: obj({a: STR})})), /property "nested".*string, number, integer, boolean or an enum/, 'a nested object');
        one(asking(obj({list: {type: 'array', items: STR}})), /property "list"/, 'an array');
        one(asking(obj({either: {type: ['string', 'null']}})), /property "either"/, 'a union type');
        one(asking(obj({ref: {$ref: '#/shared/x'}})), /property "ref"/, 'a $ref');
        one(asking(obj({pick: {oneOf: [{const: 'a'}, {const: 'b'}]}})), /property "pick"/, 'oneOf');
        one(asking(obj({mode: {enum: ['fast', 1]}})), /property "mode".*enum of strings/, 'an enum that is not of strings');
        one(asking(obj(Object.fromEntries(Array.from({length: 9}, (x, i) => [`p${i}`, STR])))), /9 properties.*at most 8/, 'nine');
        one(asking(obj({approve: {type: 'boolean'}}, {required: ['approve', 'gone']})), /required "gone" is not one of its properties/, 'a required it does not have');
        one(asking(obj({approve: {type: 'boolean'}}, {additionalProperties: obj({})})), /flat form/, 'additionalProperties that is a schema');
        one(asking(undefined), /questions\.overwrite points to .*, which is not in schema\.json/, 'a pointer to nothing');
      });

      // the reviewer's M1 on #302: the form is sent to the client as requestedSchema, so M0 bounds what it may hold
      it('a form property holds only what a form field takes, each bounded and clean', () => {
        const prop = (p) => asking(obj({field: p}));
        // what each kind may carry
        clean(prop({type: 'string', title: 'A reason', description: 'Why.', minLength: 1, maxLength: 200, format: 'email', default: 'none'}));
        clean(prop({type: 'integer', title: 'Copies', minimum: 0, maximum: 3, default: 1}));
        clean(prop({type: 'number', minimum: 0, maximum: 1, default: 0.5}));
        clean(prop({type: 'boolean', title: 'Approve', default: false}));
        clean(prop({type: 'string', enum: ['fast', 'safe'], enumNames: ['Fast', 'Safe'], default: 'safe'}));
        clean(prop({enum: Array.from({length: 64}, (x, i) => `v${i}`)}));
        // a keyword a form field does not take
        for (const extra of [{pattern: '^a+$'}, {const: 'x'}, {examples: ['x']}, {contentEncoding: 'base64'}, {'x-anything': 1}, {readOnly: true}, {minimum: 1}]) {
          one(prop(Object.assign({type: 'string'}, extra)), /property "field".*may not carry/, JSON.stringify(extra));
        }
        one(prop({type: 'boolean', maxLength: 3}), /property "field".*may not carry maxLength/, 'a string\'s keyword on a boolean');
        // bounds
        one(prop({enum: Array.from({length: 65}, (x, i) => `v${i}`)}), /property "field".*at most 64 values/, '65 values');
        one(prop({enum: ['a'.repeat(257)]}), /property "field".*at most 256 characters/, 'a long value');
        one(prop({enum: ['a', 'a']}), /property "field".*twice/, 'a value twice');
        one(prop({type: 'string', enum: ['a', 'b'], enumNames: ['A']}), /property "field".*enumNames/, 'names that do not pair');
        one(prop({type: 'string', title: 't'.repeat(129)}), /property "field".*title.*at most 128/, 'a long title');
        one(prop({type: 'string', description: 'd'.repeat(501)}), /property "field".*description.*at most 500/, 'a long description');
        one(prop({type: 'string', default: 'd'.repeat(257)}), /property "field".*default/, 'a long default');
        one(prop({type: 'integer', default: 'one'}), /property "field".*default/, 'a default of another type');
        one(prop({type: 'string', enum: ['a', 'b'], default: 'c'}), /property "field".*default/, 'a default that is no value of the enum');
        one(prop({type: 'string', format: 'regex'}), /property "field".*format/, 'a format a form has not');
        one(prop({type: 'string', minLength: -1}), /property "field".*minLength/, 'a negative length');
        one(prop({type: 'number', minimum: 'low'}), /property "field".*minimum/, 'a bound that is no number');
        // clean: no control or bidi character in anything a user is shown
        for (const dirty of [{title: 'Approve\u202e'}, {description: 'line one\nline two'}, {enum: ['a\u0007']}, {enumNames: ['A\u2066'], enum: ['a']}, {default: 'x\u001b[31m'}]) {
          one(prop(Object.assign({type: 'string'}, dirty)), /property "field".*control or bidi character/, JSON.stringify(dirty));
        }
        // the property's own name too, and the form's own title and description
        one(asking(obj({'na\u202eme': {type: 'string'}})), /property .*control or bidi character/, 'a name');
        one(asking(obj({ok: {type: 'string'}}, {title: 't'.repeat(129)})), /its title.*at most 128/, 'the form\'s title');
        one(asking(obj({ok: {type: 'string'}}, {description: 'bad\u202e'})), /its description.*control or bidi character/, 'the form\'s description');
        one(asking(obj({ok: {type: 'string'}}, {minProperties: 1})), /may not carry minProperties/, 'a keyword a form has not');
        one(asking(obj({['n'.repeat(65)]: {type: 'string'}})), /property .*name.*at most 64/, 'a long name');
      });

      it('a question\'s message carries no control or bidi character', () => {
        for (const bad of ['Replace\nit?', 'Replace \u202eit?', 'Replace\u0000 it?']) {
          one(asking(FORM, {overwrite: {message: bad, schema: Q.overwrite.schema}}), /message.*control or bidi character/, JSON.stringify(bad));
        }
      });

      it('its message holds text and {name} placeholders, nothing else in braces', () => {
        clean(asking(FORM, {overwrite: {message: 'Replace {name} in {folder_2}?', schema: Q.overwrite.schema}}));
        for (const bad of ['Replace {name?', 'Replace name}?', 'Replace {}?', 'Replace {na me}?', 'Replace {{name}}?', 'Replace {name.first}?', 'Replace {1st}?']) {
          one(asking(FORM, {overwrite: {message: bad, schema: Q.overwrite.schema}}), /message.*\{name\} placeholders/, bad);
        }
      });

      it('a property that reads like a credential is a warning: a form must never ask for one', () => {
        for (const [name, title] of [['password', undefined], ['apiToken', undefined], ['x', 'Your API key'], ['client_secret', undefined], ['cardNumber', undefined], ['x', 'Card number']]) {
          const r = asking(obj({[name]: Object.assign({type: 'string'}, title ? {title} : {})}));
          clean(r, name);
          assert.strictEqual(r.warnings.length, 1, `${name} / ${title}`);
          assert.match(r.warnings[0].message, /reads like a credential/);
        }
        assert.deepStrictEqual(asking(FORM).warnings, [], 'approve, reason, count, ratio, mode');
        // "key" inside another word is not one
        assert.deepStrictEqual(asking(obj({monkey: STR, keyboard: STR})).warnings, []);
      });
    });

    describe('annotations (section 4)', () => {
      it('readOnlyHint with destructiveHint is a warning, not a problem', () => {
        const r = withActions({action: {annotations: {readOnlyHint: true, destructiveHint: true}}});
        clean(r);
        assert.strictEqual(r.warnings.length, 1);
        assert.match(r.warnings[0].message, /readOnlyHint and destructiveHint are both true/);
        assert.deepStrictEqual(withActions({action: {annotations: {readOnlyHint: true, destructiveHint: false}}}).warnings, []);
      });
    });
  });

  // The same checks at the two places a module meets them: validate says
  // every problem and every warning; the load refuses for the first problem,
  // with MODULE_ASSEMBLY_FAIL at stage=declarations, before any of the
  // module's code runs. (In a validator, as a spawn makes the check:
  // test/module-loading/23.)
  describe('where the checks are made', () => {
    const declarations = require('../../lib/declarations');
    const moduleValidator = require('../../lib/module-validator');
    const schemaSafety = require('../../lib/schema-safety');
    const GREET = 'urn:countinghouse-test:serviceID:greetService';
    const PNG = {type: 'string', contentEncoding: 'base64', contentMediaType: 'image/png'};
    const dirs = [];
    after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
    // the well-formed fixture, with `action` laid over its one action and
    // `output` as that action's output schema (null: no schema.json at all)
    function moduleWith(name, {action = {}, input, output, extra = {}} = {}) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ch-decl-${name}-`));
      dirs.push(dir);
      fs.cpSync(path.join(__dirname, '..', 'fixtures', 'handler-map-convention'), dir, {recursive: true});
      const api = JSON.parse(fs.readFileSync(path.join(dir, 'api.json'), 'utf8'));
      Object.assign(api.device.serviceList[GREET].actionList[0], action);
      fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify(api));
      if (output === null) {
        fs.rmSync(path.join(dir, 'schema.json'));
      } else {
        const schema = JSON.parse(fs.readFileSync(path.join(dir, 'schema.json'), 'utf8'));
        if (input !== undefined) schema.greetService.hello.input = input;
        if (output !== undefined) schema.greetService.hello.output = output;
        fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(Object.assign(schema, extra)));
      }
      return dir;
    }
    const validated = (dir) => new Promise((resolve, reject) => moduleValidator.validateModule(dir, (err, result) => (err ? reject(err) : resolve(result))));
    const declared = (result) => result.problems.filter((p) => p.stage === 'declarations');

    it('validate: a module that declares nothing new is ok as before, with no declarations problem or warning', async () => {
      const result = await validated(moduleWith('plain'));
      assert.strictEqual(result.ok, true, JSON.stringify(result.problems));
      assert.deepStrictEqual(result.warnings.filter((w) => w.stage === 'declarations'), []);
      assert.strictEqual(schemaSafety.schemaRefusal(moduleWith('plain-load'), 'plain-load'), null);
    });

    it('validate: every problem is reported, at stage "declarations", each with what to do', async () => {
      const result = await validated(moduleWith('several', {
        action: {resource: {uriTemplate: 'greetings/{who}', name: 'greeting'}},
        input: {type: 'object', properties: {name: {type: 'string', 'x-mcp-header': 'X-Name'}}, required: ['name']},
        output: {type: 'object', properties: {card: {$ref: '#/shared/card'}}},
        extra: {shared: {card: PNG}}
      }));
      assert.strictEqual(result.ok, false);
      const messages = declared(result).map((p) => p.message);
      assert.strictEqual(messages.length, 4, JSON.stringify(messages));
      assert.ok(messages.some((m) => /binary field is reached through a \$ref/.test(m)));
      assert.ok(messages.some((m) => /x-mcp-header is not served/.test(m)));
      assert.ok(messages.some((m) => /variable \{who\} is not a property of its input/.test(m)));
      assert.ok(messages.some((m) => /required input "name" is not a variable/.test(m)));
      for (const p of declared(result)) {
        assert.strictEqual(p.module, 'handler-map-convention');
        assert.strictEqual(typeof(p.fix), 'string');
      }
    });

    it('validate: a warning does not fail the module', async () => {
      const result = await validated(moduleWith('warned', {action: {annotations: {readOnlyHint: true, destructiveHint: true}}}));
      assert.strictEqual(result.ok, true, JSON.stringify(result.problems));
      const warned = result.warnings.filter((w) => w.stage === 'declarations');
      assert.strictEqual(warned.length, 1);
      assert.match(warned[0].message, /readOnlyHint and destructiveHint are both true/);
    });

    it('the load: the first problem refuses the module, MODULE_ASSEMBLY_FAIL at stage=declarations, naming the module', () => {
      const e = schemaSafety.schemaRefusal(moduleWith('ref-binary', {output: {type: 'object', properties: {card: {$ref: '#/shared/card'}}}, extra: {shared: {card: PNG}}}), 'ref-binary');
      assert.strictEqual(e.code, 'MODULE_ASSEMBLY_FAIL');
      assert.match(e.message, /ref-binary/);
      assert.match(e.message, /stage=declarations -- greetService\.hello output .*declare it inline, under properties or items/);
      assert.ok(!/would stall or exhaust/.test(e.message), 'not the safety check\'s words');
      const header = schemaSafety.schemaRefusal(moduleWith('header', {input: {type: 'object', properties: {name: {type: 'string', 'x-mcp-header': 'X-Name'}}}}), 'header');
      assert.match(header.message, /stage=declarations -- .*x-mcp-header is not served/);
    });

    it('the load: a module with no schema.json is checked too (a resource\'s template needs none)', () => {
      const e = schemaSafety.schemaRefusal(moduleWith('no-schema', {action: {input: undefined, output: undefined, resource: {uriTemplate: '../greetings', name: 'greeting'}}, output: null}), 'no-schema');
      assert.strictEqual(e.code, 'MODULE_ASSEMBLY_FAIL');
      assert.match(e.message, /stage=declarations -- .*uriTemplate/);
    });

    it('the load: a warning refuses nothing, and the safety check\'s own refusal comes first, as it was', () => {
      assert.strictEqual(schemaSafety.schemaRefusal(moduleWith('warned-load', {action: {annotations: {readOnlyHint: true, destructiveHint: true}}}), 'warned-load'), null);
      const both = schemaSafety.schemaRefusal(moduleWith('both', {
        input: {type: 'object', properties: {name: {type: 'string', pattern: '^(a+)+$', 'x-mcp-header': 'X-Name'}}}
      }), 'both');
      assert.match(both.message, /stage=schemaSafety -- .*would stall or exhaust its validators/);
    });

    it('the load\'s refusal is a log line a module cannot shape: what it names is cut, and carries no control character', () => {
      // an action's name is not yet checked against the meta-schema when this runs: any string, any length
      const spec = specOf({name: `read\nERROR forged line \u001b[31m${'x'.repeat(5000)}`, resource: {uriTemplate: 'a//b', name: 'n'}});
      const problem = schemaSafety.schemaProblem(null, spec);
      assert.strictEqual(problem.stage, 'declarations');
      const message = schemaSafety.refusalFor('shaped', problem).message;
      assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(message), JSON.stringify(message.slice(0, 120)));
      assert.ok(message.length < 700, String(message.length));
    });

    // the reviewer's I1 on #302: validate's result reaches an MCP client (countinghouse_validate_module), so
    // what it says is cut and cleaned at its source, as the load's line is
    it('every message of the checks, a problem\'s and a warning\'s and an icon\'s, is cut and carries no control or bidi character', async () => {
      const DIRTY = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
      const evil = `k\n\u001b[31m\u202e${'x'.repeat(5000)}`;
      const spec = specOf({
        name: `read${evil}`,
        resource: {uriTemplate: 'notes/{id}', name: 'note', changesWith: [`notesService.${evil}`], completion: {[evil]: `notesService.${evil}`}},
        questions: {overwrite: {message: 'Replace it?', schema: '/q/form'}},
        icons: [{file: `icons/${evil}.png`}]
      }, {promptList: [{name: 'triage', arguments: {schema: '/p/args'}, messages: [{role: 'user', text: `Triage {{${evil}}} and {{ ${evil} }}.`}], completion: {[evil]: 'notesService.none'}}]});
      const schema = {notesService: {[`read${evil}`]: {}}, q: {form: {type: 'object', properties: {[evil]: {type: 'object'}, password: {type: 'string', title: evil}}, required: [evil, `also${evil}`]}},
        p: {args: {type: 'object', properties: {[evil]: {type: 'integer'}, [`s${evil}`]: {type: 'string'}}, required: [`gone${evil}`]}}};
      spec.device.serviceList[SERVICE].actionList[0].input = {schema: '/in'};
      schema.in = {type: 'object', properties: {id: {type: 'string'}}, required: ['id', evil]};
      const r = declarations.check(spec, schema);
      assert.ok(r.problems.length >= 8 && r.warnings.length >= 2, `${r.problems.length} problems, ${r.warnings.length} warnings`);
      const iconProblems = require('../../lib/declared-icons').problems(os.tmpdir(), spec);
      assert.strictEqual(iconProblems.length, 1);
      for (const p of r.problems.concat(r.warnings, iconProblems)) {
        assert.ok(p.message.length <= 512 && p.path.length <= 512, `${p.message.length}: ${JSON.stringify(p.message.slice(0, 80))}`);
        assert.ok(!DIRTY.test(p.message) && !DIRTY.test(p.path), JSON.stringify(p.message.slice(0, 120)));
      }
      // and so what validate answers with
      const dir = moduleWith('dirty', {action: {resource: {uriTemplate: 'notes/{id}', name: 'note', changesWith: [`greetService.${evil}`]}}});
      const result = await validated(dir);
      const said = result.problems.filter((p) => p.stage === 'declarations');
      assert.ok(said.length >= 1);
      for (const p of said) assert.ok(p.message.length <= 512 && !DIRTY.test(p.message), JSON.stringify(p.message.slice(0, 120)));
    });

    it('schemaProblem (what a validator runs for a spawn) gives the problem its stage; refusalFor says it', () => {
      const api = JSON.stringify(specOf({resource: {uriTemplate: 'notes/{id}/{id}', name: 'note'}}));
      const problem = schemaSafety.schemaProblem(JSON.stringify({notesService: {readNote: {input: {type: 'object', properties: {id: {type: 'string'}}}, output: {type: 'object'}}}}), JSON.parse(api));
      assert.strictEqual(problem.stage, 'declarations');
      assert.match(schemaSafety.refusalFor('twice', problem).message, /twice.*stage=declarations -- readNote|stage=declarations -- notesService\.readNote resource: uriTemplate/);
      // no schema.json: the text is null
      assert.strictEqual(schemaSafety.schemaProblem(null, JSON.parse(api)).stage, 'declarations');
      assert.strictEqual(schemaSafety.schemaProblem(null, specOf()), null);
      assert.strictEqual(schemaSafety.schemaProblem(null, null), null);
    });
  });

  // Icons are files inside the module (section 4): never a URL. validate
  // checks each one; the load reads them with the same read (M2, which
  // inlines them), and is the one that decides.
  describe('icon files (lib/declared-icons.js)', () => {
    const icons = require('../../lib/declared-icons');
    const moduleValidator = require('../../lib/module-validator');
    // bytes that begin as each type does
    const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
    const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
    const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([44, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(40)]);
    const dirs = [];
    after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
    // a directory holding `files` ({relative path: bytes})
    function dirWith(files) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-icons-'));
      dirs.push(dir);
      for (const [rel, bytes] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true});
        fs.writeFileSync(path.join(dir, rel), bytes);
      }
      return dir;
    }
    const problemOf = (dir, file) => icons.read(dir, file).problem;

    it('a PNG, a JPEG and a WebP are taken by their first bytes, whatever the file is called', () => {
      const dir = dirWith({'icons/a.png': PNG_BYTES, 'icons/b.jpg': JPEG_BYTES, 'icons/c.webp': WEBP_BYTES, 'icons/chart.bin': PNG_BYTES, 'top.png': PNG_BYTES});
      assert.deepStrictEqual(icons.read(dir, 'icons/a.png'), {mimeType: 'image/png', bytes: PNG_BYTES});
      assert.strictEqual(icons.read(dir, 'icons/b.jpg').mimeType, 'image/jpeg');
      assert.strictEqual(icons.read(dir, 'icons/c.webp').mimeType, 'image/webp');
      assert.strictEqual(icons.read(dir, 'icons/chart.bin').mimeType, 'image/png', 'the bytes decide, not the name');
      assert.strictEqual(icons.read(dir, 'top.png').mimeType, 'image/png');
    });

    it('SVG is refused, and says why; anything else is not an image this takes', () => {
      const dir = dirWith({'a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'b.png': '<?xml version="1.0"?>\n<svg/>', 'c.png': '  <!DOCTYPE svg><svg/>',
        'named.svg': PNG_BYTES, 'd.gif': `GIF89a${'x'.repeat(40)}`, 'e.png': '', 'f.png': 'just text', 'g.webp': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(20)])});
      for (const file of ['a.svg', 'b.png', 'c.png', 'named.svg']) assert.match(problemOf(dir, file), /SVG is refused: it can carry script/, file);
      for (const file of ['d.gif', 'e.png', 'f.png', 'g.webp']) assert.match(problemOf(dir, file), /is not a PNG, JPEG or WebP/, file);
    });

    it('at most 16 KiB', () => {
      const dir = dirWith({'at.png': Buffer.concat([PNG_BYTES, Buffer.alloc(16384 - PNG_BYTES.length)]), 'over.png': Buffer.concat([PNG_BYTES, Buffer.alloc(16385 - PNG_BYTES.length)])});
      assert.strictEqual(icons.read(dir, 'at.png').bytes.length, 16384);
      assert.match(problemOf(dir, 'over.png'), /is 16385 bytes; an icon is at most 16384/);
    });

    it('a file that is not there, a directory, and a path that is not one inside the module', () => {
      const dir = dirWith({'icons/a.png': PNG_BYTES});
      assert.match(problemOf(dir, 'icons/none.png'), /does not exist/);
      assert.match(problemOf(dir, 'icons'), /is not a file/);
      for (const bad of ['../a.png', '/etc/a.png', 'icons/../../a.png', 'icons/..', 'https://example.com/a.png', 'data:image/png;base64,AAAA', 'icons\\a.png', '', 'a'.repeat(257), 7, null]) {
        assert.match(problemOf(dir, bad), /is not a path inside the module/, JSON.stringify(bad));
      }
    });

    it('a symlink that leaves the module is refused; one inside it is the file it names', function() {
      if (process.platform === 'win32') return this.skip();   // a symlink needs a privilege there
      const outside = dirWith({'secret.png': PNG_BYTES});
      const dir = dirWith({'icons/a.png': PNG_BYTES});
      fs.symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'icons', 'out.png'));
      fs.symlinkSync(path.join(dir, 'icons', 'a.png'), path.join(dir, 'icons', 'in.png'));
      assert.match(problemOf(dir, 'icons/out.png'), /is outside the module/);
      assert.ok(!problemOf(dir, 'icons/out.png').includes(outside), 'the path it leads to is not said');
      assert.strictEqual(icons.read(dir, 'icons/in.png').mimeType, 'image/png');
    });

    // /code-review of #302, 7: what is opened is the file that was checked, and nothing that could hold the reader
    it('a FIFO where an icon should be is refused at once, never read', function() {
      if (process.platform === 'win32') return this.skip();
      this.timeout(5000);
      const dir = dirWith({'icons/a.png': PNG_BYTES});
      require('child_process').execFileSync('mkfifo', [path.join(dir, 'icons', 'pipe.png')]);
      assert.match(problemOf(dir, 'icons/pipe.png'), /is not a file/);
    });

    it('the path pattern is the meta-schema\'s own, not a copy of it', () => {
      const meta = require('../../spec/schema.json');
      assert.strictEqual(icons.FILE.source, new RegExp(meta.$defs.icons.items.properties.file.pattern).source);
    });

    it('problems(): every icons list of the module, an action\'s, a resource\'s and a prompt\'s, each said with whose it is; a file is read once', () => {
      const dir = dirWith({'icons/a.png': PNG_BYTES, 'icons/bad.png': 'text'});
      const spec = specOf({icons: [{file: 'icons/a.png', sizes: ['48x48']}, {file: 'icons/bad.png'}], resource: {uriTemplate: 'notes/{id}', name: 'note', icons: [{file: 'icons/none.png'}]}},
        {promptList: [{name: 'triage', icons: [{file: 'icons/bad.png'}, {file: 'icons/a.png'}], messages: [{role: 'user', text: 'x'}]}]});
      const found = icons.problems(dir, spec);
      assert.deepStrictEqual(found.map((p) => p.path), ['notesService.readNote icons', 'notesService.readNote resource icons', 'prompt triage icons']);
      assert.match(found[0].message, /notesService\.readNote icons: "icons\/bad\.png" is not a PNG, JPEG or WebP/);
      assert.match(found[1].message, /resource icons: "icons\/none\.png" does not exist/);
      assert.match(found[2].message, /prompt triage icons: "icons\/bad\.png" is not a PNG/);
      // nothing declared, and a spec that is not one: nothing
      assert.deepStrictEqual(icons.problems(dir, specOf()), []);
      for (const junk of [null, 7, {}, {device: {serviceList: 7, promptList: 'x'}}, specOf({icons: 'x', resource: {icons: 7}})]) assert.deepStrictEqual(icons.problems(dir, junk), [], JSON.stringify(junk));
    });

    it('problems() reads at most 256 declared icons: more is one problem, and no more files are read', () => {
      const dir = dirWith({});
      const spec = specOf();
      spec.device.serviceList[SERVICE].actionList = Array.from({length: 70}, (x, i) => ({name: `a${i}`, icons: [0, 1, 2, 3].map((n) => ({file: `icons/${i}-${n}.png`}))}));
      const found = icons.problems(dir, spec);
      assert.strictEqual(found.length, 257);
      assert.match(found[256].message, /more than 256 icons are declared/);
    });

    it('validate reports an icon\'s problem at stage "declarations"', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-decl-icons-'));
      dirs.push(dir);
      fs.cpSync(path.join(__dirname, '..', 'fixtures', 'handler-map-convention'), dir, {recursive: true});
      const api = JSON.parse(fs.readFileSync(path.join(dir, 'api.json'), 'utf8'));
      api.device.serviceList['urn:countinghouse-test:serviceID:greetService'].actionList[0].icons = [{file: 'icons/a.png'}, {file: 'icons/logo.svg'}];
      fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify(api));
      fs.mkdirSync(path.join(dir, 'icons'));
      fs.writeFileSync(path.join(dir, 'icons', 'a.png'), PNG_BYTES);
      fs.writeFileSync(path.join(dir, 'icons', 'logo.svg'), '<svg/>');
      const result = await new Promise((resolve, reject) => moduleValidator.validateModule(dir, (err, r) => (err ? reject(err) : resolve(r))));
      assert.strictEqual(result.ok, false);
      const declared = result.problems.filter((p) => p.stage === 'declarations');
      assert.strictEqual(declared.length, 1, JSON.stringify(result.problems));
      assert.match(declared[0].message, /greetService\.hello icons: "icons\/logo\.svg" SVG is refused/);
    });
  });

  // One module that declares all of it, for the tasks that serve each part
  // (M2 and on) to load. It is held complete by the meta-schema itself: a
  // field added there fails here until the fixture declares it.
  describe('the fixture that declares everything (test/fixtures/declares-everything)', () => {
    const declarations = require('../../lib/declarations');
    const icons = require('../../lib/declared-icons');
    const FIXTURE = path.join(__dirname, '..', 'fixtures', 'declares-everything');
    const read = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURE, name), 'utf8'));
    const actionsOf = (api) => Object.values(api.device.serviceList).flatMap((s) => s.actionList);

    it('is accepted by the meta-schema, by every declaration check, by validate and by the load\'s refusal check', async () => {
      const api = read('api.json');
      await accepted(api, 'the meta-schema');
      assert.deepStrictEqual(declarations.check(api, read('schema.json')), {problems: [], warnings: []});
      assert.deepStrictEqual(icons.problems(FIXTURE, api), []);
      const result = await new Promise((resolve, reject) => require('../../lib/module-validator').validateModule(FIXTURE, (err, r) => (err ? reject(err) : resolve(r))));
      assert.deepStrictEqual(result.problems, []);
      assert.deepStrictEqual(result.warnings, []);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(require('../../lib/schema-safety').schemaRefusal(FIXTURE, 'declares-everything'), null);
    });

    it('declares every field the meta-schema gives an action, a resource, annotations, an icon and a prompt', () => {
      const meta = require('../../spec/schema.json');
      const services = meta.properties.device.properties.serviceList.patternProperties;
      const action = services[Object.keys(services)[0]].properties.actionList.items.properties;
      const prompt = meta.properties.device.properties.promptList.items.properties;
      const api = read('api.json');
      const actions = actionsOf(api);
      const prompts = api.device.promptList;
      const unused = (declared, things) => Object.keys(declared).filter((k) => !things.some((t) => t != null && Object.prototype.hasOwnProperty.call(t, k)));
      assert.deepStrictEqual(unused(action, actions), [], 'an action\'s fields');
      assert.deepStrictEqual(unused(action.resource.properties, actions.map((a) => a.resource)), [], 'a resource\'s fields');
      assert.deepStrictEqual(unused(action.annotations.properties, actions.map((a) => a.annotations)), [], 'the annotations');
      assert.deepStrictEqual(unused(prompt, prompts), [], 'a prompt\'s fields');
      const everyIcon = actions.flatMap((a) => (a.icons || []).concat((a.resource && a.resource.icons) || [])).concat(prompts.flatMap((p) => p.icons || []));
      assert.deepStrictEqual(unused(meta.$defs.icons.items.properties, everyIcon), [], 'an icon\'s fields');
      assert.deepStrictEqual([...new Set(prompts.flatMap((p) => p.messages.map((m) => m.role)))].sort(), ['assistant', 'user'], 'both roles');
    });

    it('and has one of each kind of thing: a template and a static resource, binary fields under properties and under items, each form type in a question, a completion for a variable and for an argument', () => {
      const api = read('api.json');
      const schema = read('schema.json');
      const actions = actionsOf(api);
      const templates = actions.filter((a) => a.resource != null).map((a) => a.resource.uriTemplate);
      assert.ok(templates.some((x) => x.includes('{')) && templates.some((x) => !x.includes('{')), JSON.stringify(templates));
      assert.ok(actions.some((a) => a.longRunning === true && a.resource == null));
      const binary = require('../../lib/binary-fields');
      const fields = actions.flatMap((a) => (a.output != null ? binary.binaryFields(declarations.pointed(schema, a.output.schema)) : []));
      assert.ok(fields.some((x) => !x.path.includes('*')) && fields.some((x) => x.path.includes('*')), JSON.stringify(fields));
      assert.ok(new Set(fields.map((x) => x.mediaType)).size >= 2, 'more than one media type');
      const forms = actions.flatMap((a) => Object.values(a.questions || {})).map((q) => declarations.pointed(schema, q.schema));
      const kinds = new Set(forms.flatMap((form) => Object.values(form.properties).map((p) => (p.enum != null ? 'enum' : p.type))));
      assert.deepStrictEqual([...kinds].sort(), ['boolean', 'enum', 'integer', 'number', 'string']);
      assert.ok(actions.some((a) => a.resource != null && a.resource.completion != null) && api.device.promptList.some((p) => p.completion != null));
      assert.ok(actions.some((a) => a.resource != null && Array.isArray(a.resource.changesWith)));
    });
  });
});
