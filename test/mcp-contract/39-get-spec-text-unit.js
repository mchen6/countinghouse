'use strict';
// get-spec answers a usable action's declared text as the MCP lists show it
// (the reviewer's ruling on #400's follow-up; M18, mcp-contract 34): a title
// as one line, a description and a prompt message's text as a message. Text
// only, never structure; a copy, so the spec the runtime serves is never
// changed; keys defined, never assigned, so a "__proto__" key stays a key.
const assert = require('assert');
const {cleanedSpecText} = require('../../lib/spec-text');

const ZWSP = '​';
const RLO = '‮';
const spec = () => JSON.parse(JSON.stringify({
  device: {
    friendlyName: 'texty',
    manufacturer: `Acme${ZWSP}`,
    modelName: `M${RLO}1\n2`,
    modelDescription: `reads${ZWSP} this\nand that`,
    deviceList: [{device: {friendlyName: 'inner', modelDescription: `in${RLO}ner`, serviceList: {}}}],
    serviceList: {
      'urn:x:serviceID:s': {
        serviceType: 'urn:x:service:s:1',
        actionList: [
          {name: 'tool', title: `A${ZWSP}title\nline`, description: `does${RLO} it\nwell\tok`, input: {schema: '/s/tool/input'},
            questions: {confirm: {message: `Proceed${RLO}?\nnow`, schema: '/s/tool/confirm'}}},
          {name: 'res', description: `a${ZWSP}resource`, resource: {uriTemplate: 'texty://x', name: 'r', title: `R${RLO}`, description: `the${ZWSP}\nfile`}},
          {name: 'plain', description: 'nothing hidden'}
        ]
      }
    },
    promptList: [{name: 'p', title: `P${ZWSP}`, description: `pd${RLO}`, messages: [{role: 'user', text: `hello${ZWSP}\n{{who}}`}]}]
  }
}));

describe('mcp-contract 39: get-spec\'s declared text, as the lists show it (unit)', () => {
  it('titles become one line, descriptions and message text keep \\n and \\t, each hidden character a space', () => {
    const out = cleanedSpecText(spec());
    const [tool, res, plain] = out.device.serviceList['urn:x:serviceID:s'].actionList;
    assert.strictEqual(tool.title, 'A title line');
    assert.strictEqual(tool.description, 'does  it\nwell\tok');
    assert.strictEqual(tool.questions.confirm.message, 'Proceed ? now', 'a question\'s message, one line as its dialog');
    assert.strictEqual(tool.questions.confirm.schema, '/s/tool/confirm');
    assert.strictEqual(res.description, 'a resource');
    assert.strictEqual(res.resource.title, 'R ');
    assert.strictEqual(res.resource.description, 'the \nfile');
    assert.strictEqual(plain.description, 'nothing hidden');
    const [p] = out.device.promptList;
    assert.strictEqual(p.title, 'P ');
    assert.strictEqual(p.description, 'pd ');
    assert.strictEqual(p.messages[0].text, 'hello \n{{who}}');
  });

  it('text only: every other key and value is as declared, and the served spec is not changed', () => {
    const served = spec();
    const before = JSON.stringify(served);
    const out = cleanedSpecText(served);
    assert.strictEqual(JSON.stringify(served), before, 'the served spec untouched');
    assert.notStrictEqual(out, served);
    const strip = (s) => JSON.parse(JSON.stringify(s, (k, v) => (['title', 'description', 'text', 'message', 'manufacturer', 'modelName', 'modelDescription'].includes(k) ? undefined : v)));
    assert.deepStrictEqual(strip(out), strip(served), 'the same structure');
    assert.deepStrictEqual(out.device.serviceList['urn:x:serviceID:s'].actionList[1].resource.uriTemplate, 'texty://x');
  });

  it('a "__proto__" key is copied as a key, never set as a prototype', () => {
    const s = spec();
    const action = s.device.serviceList['urn:x:serviceID:s'].actionList[0];
    Object.defineProperty(action, '__proto__', {value: {polluted: true}, enumerable: true, configurable: true, writable: true});
    const out = cleanedSpecText(s);
    const copy = out.device.serviceList['urn:x:serviceID:s'].actionList[0];
    assert.ok(Object.hasOwn(copy, '__proto__'));
    assert.strictEqual(copy.polluted, undefined, 'not a prototype');
    assert.strictEqual(Object.getPrototypeOf(copy), Object.prototype);
  });

  it('the device\'s own text and an embedded device\'s are cleaned; its identifiers are not', () => {
    const out = cleanedSpecText(spec());
    assert.strictEqual(out.device.manufacturer, 'Acme ');
    assert.strictEqual(out.device.modelName, 'M 1 2');
    assert.strictEqual(out.device.modelDescription, 'reads  this\nand that');
    assert.strictEqual(out.device.friendlyName, 'texty');
    assert.strictEqual(out.device.deviceList[0].device.modelDescription, 'in ner');
    assert.strictEqual(out.device.deviceList[0].device.friendlyName, 'inner');
  });

  it('a spec with nothing to clean is handed on as it is, never copied', () => {
    const clean = {device: {friendlyName: 'c', manufacturer: 'Acme', serviceList: {'urn:x:serviceID:s': {actionList: [{name: 'a', description: 'fine'}]}},
      promptList: [{name: 'p', description: 'ok', messages: [{role: 'user', text: 'hi'}]}]}};
    assert.strictEqual(cleanedSpecText(clean), clean);
  });

  it('a prompt to leave out is left out; the rest stay, cleaned', () => {
    const s = spec();
    s.device.promptList.push({name: 'other', description: `o${ZWSP}`});
    const out = cleanedSpecText(s, {leaveOut: new Set(['p'])});
    assert.deepStrictEqual(out.device.promptList.map((p) => p.name), ['other']);
    assert.strictEqual(out.device.promptList[0].description, 'o ');
  });

  it('anything that is not a spec is passed as it is', () => {
    for (const v of [null, undefined, 'x', 1, [], {}, {device: null}]) assert.strictEqual(cleanedSpecText(v), v);
  });
});

describe('mcp-contract 39: withoutUnusable\'s copy keeps a "__proto__" key a key', () => {
  const verdict = require('../../lib/hidden-text-verdict');
  it('the spec and its device are copied by defining keys, never by assigning them', () => {
    const id = 'aaaaaaaa-0000-5000-8000-0000000000aa';
    verdict.set(id, [['urn:x:serviceID:s', 'hidden']]);
    const s = {device: {serviceList: {'urn:x:serviceID:s': {actionList: [{name: 'hidden'}, {name: 'kept'}]}}}};
    Object.defineProperty(s, '__proto__', {value: {polluted: 1}, enumerable: true, configurable: true, writable: true});
    Object.defineProperty(s.device, '__proto__', {value: {polluted: 2}, enumerable: true, configurable: true, writable: true});
    try {
      const out = verdict.withoutUnusable(s, id);
      assert.deepStrictEqual(out.device.serviceList['urn:x:serviceID:s'].actionList.map((a) => a.name), ['kept']);
      for (const o of [out, out.device]) {
        assert.ok(Object.hasOwn(o, '__proto__'));
        assert.strictEqual(o.polluted, undefined);
        assert.strictEqual(Object.getPrototypeOf(o), Object.prototype);
      }
    } finally {
      verdict.forget(id);
    }
  });
});


// #447's high review, 6: one field table chooses the rule for each declared
// text field (one line, or a message keeping \n and \t), and the cleaning is
// lib/module-text.js's alone; tools/list, prompts/list, resources/list, a
// prompt's messages, get-spec and /device-list read the table, so the lists
// and the routes cannot drift apart
describe('mcp-contract 39: one table of declared text fields', () => {
  const specText = require('../../lib/spec-text');
  const moduleText = require('../../lib/module-text');
  const fs = require('fs');
  const path = require('path');

  it('chooses one line or a message for each field, by kind', () => {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(specText.TEXT_FIELDS)), {
      action: {title: 'line', description: 'message'},
      resource: {title: 'line', description: 'message'},
      prompt: {title: 'line', description: 'message'},
      argument: {description: 'message'},
      question: {message: 'line'},
      promptMessage: {text: 'message'},
      device: {modelDescription: 'message', description: 'message'}
    });
    assert.ok(Object.isFrozen(specText.TEXT_FIELDS) && Object.values(specText.TEXT_FIELDS).every(Object.isFrozen));
  });

  it('cleans by module-text\'s line() and message(), nothing of its own', () => {
    const raw = `a${ZWSP}b\nc\td${RLO}`;
    for (const [kind, fields] of Object.entries(specText.TEXT_FIELDS)) {
      for (const [field, rule] of Object.entries(fields)) {
        assert.strictEqual(specText.cleanText(kind, field, raw), moduleText[rule](raw), `${kind}.${field}`);
      }
    }
    // a device's other free text: one line
    assert.strictEqual(specText.cleanText('device', 'manufacturer', raw), moduleText.line(raw));
    assert.throws(() => specText.cleanText('action', 'name', raw), /no declared text field action\.name/);
    assert.throws(() => specText.cleanText('nothing', 'title', raw), /no declared text field nothing\.title/);
  });

  it('cleanedFields: the kind\'s string fields present, cleaned; nothing else', () => {
    assert.deepStrictEqual(specText.cleanedFields('prompt', {name: `n${ZWSP}`, title: `t${ZWSP}\n`, description: `d${RLO}\n`, x: 1}),
      {title: 't  ', description: 'd \n'});
    assert.deepStrictEqual(specText.cleanedFields('argument', {name: 'a', title: 'no'}), {});
  });

  // the lists clean declared text only through the table: no file clean
  // its own fields by line() or message() (tool-registry's one use is a
  // check that a description is more than hidden characters, never output)
  it('tools/list, prompts/list, resources/list and spec-text call no line() or message() of their own', () => {
    const allowed = {'lib/mcp/tool-registry.js': 1, 'lib/mcp/prompts.js': 0, 'lib/mcp/resources.js': 0, 'lib/spec-text.js': 0};
    for (const [file, n] of Object.entries(allowed)) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      const uses = src.match(/\b(clientText|moduleText)\.(line|message)\(/g) || [];
      assert.strictEqual(uses.length, n, `${file}: ${uses.join(', ')}`);
    }
  });
});
