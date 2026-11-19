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

  // the lists clean declared text only through the table (the high review
  // of #457, 2): every file under lib/ that reaches module-text's line() or
  // message() -- through client-text or module-text, by a name, a lazy
  // require (clientTextLib()), a destructured line or message, or a require
  // called in place -- is one of these, with exactly this many uses; any
  // other caller fails. Each allowed use cleans text that is no declared
  // field of the table.
  const ALLOWED = {
    'lib/client-text.js': null,          // the cleaner's own re-export and its schema walk
    'lib/spec-text.js': 2,               // the table's two rules
    'lib/declarations.js': 3,            // the load's warnings (a log, not a list)
    'lib/mcp/gateway.js': 3,             // a prompt argument's schema errors; a failed task's reason (twice)
    'lib/mcp/result-content.js': 1,      // a call result's resource link (the module's output)
    'lib/mcp/tool-registry.js': 1        // a description of hidden characters alone is none
  };
  const usesIn = (src) => {
    const MOD = String.raw`require\(\s*['"][^'"]*(?:client-text|module-text)['"]\s*\)`;
    let n = 0;
    for (const m of src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*(?:\w+\(\s*\(\)\s*=>\s*)?${MOD}`, 'g'))) {
      n += (src.match(new RegExp(String.raw`\b${m[1]}(?:\(\))?\.(?:line|message)\b`, 'g')) || []).length;
    }
    for (const m of src.matchAll(new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${MOD}`, 'g'))) {
      for (const part of m[1].split(',')) {
        const [k, v] = part.split(':').map((x) => x.trim());
        if (k === 'line' || k === 'message') n += (src.match(new RegExp(String.raw`(?<![\w.])${v || k}\b`, 'g')) || []).length - 1;
      }
    }
    n += (src.match(new RegExp(String.raw`${MOD}\.(?:line|message)\b`, 'g')) || []).length;
    return n;
  };
  it('only the files listed reach module-text\'s line() or message(), each as often as listed', () => {
    const lib = path.join(__dirname, '..', '..', 'lib');
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, {withFileTypes: true})) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p);
      }
    })(lib);
    const found = {};
    for (const f of files) {
      const rel = path.relative(path.join(lib, '..'), f).split(path.sep).join('/');
      if (rel === 'lib/module-text.js') continue;
      const n = usesIn(fs.readFileSync(f, 'utf8'));
      if (n > 0) found[rel] = Object.hasOwn(ALLOWED, rel) && ALLOWED[rel] === null ? null : n;
    }
    assert.deepStrictEqual(found, ALLOWED);
  });

  it('the guard sees every alias', () => {
    assert.strictEqual(usesIn("const clientText = require('../client-text');\nclientText.line(x); clientText.message(y);"), 2);
    assert.strictEqual(usesIn("const clientTextLib = requireOnce(() => require('../client-text'));\nclientTextLib().message(x);"), 1);
    assert.strictEqual(usesIn("const {line, message: m} = require('./module-text');\nline(a); m(b);"), 2);
    assert.strictEqual(usesIn("require('./client-text').line(a);"), 1);
    assert.strictEqual(usesIn("const t = require('./module-text');\nconst f = t.message;"), 1, 'a reference, not only a call');
    assert.strictEqual(usesIn("const t = require('./module-text');\nt.moduleLine(a);"), 0);
  });
});
