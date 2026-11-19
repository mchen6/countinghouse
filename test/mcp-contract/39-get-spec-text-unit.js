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
    const strip = (s) => JSON.parse(JSON.stringify(s, (k, v) => (['title', 'description', 'text', 'message'].includes(k) ? undefined : v)));
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

  it('anything that is not a spec is passed as it is', () => {
    for (const v of [null, undefined, 'x', 1, [], {}, {device: null}]) assert.strictEqual(cleanedSpecText(v), v);
  });
});
