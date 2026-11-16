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
        for (const bad of ['png', 'image/', '/png', 'image/png; charset=binary', 'image/p ng', '']) {
          one(checked({output: obj({image: {type: 'string', contentEncoding: 'base64', contentMediaType: bad}})}), /media type/, JSON.stringify(bad));
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
});
