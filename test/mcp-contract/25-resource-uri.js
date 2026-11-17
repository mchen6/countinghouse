'use strict';
// MCP completeness M7, spec section 3: the one strict parser of a module
// resource's URI, countinghouse://m/<module>/<path> (lib/mcp/resource-uri.js).
// A path is matched against a module's templates (M0's templateOf: literals
// and at most one {var} a segment). A variable matches unreserved characters
// and percent-escapes only, so it never spans a /; it is percent-decoded as
// UTF-8, fatally, and refused when it holds a control character, a / or a \,
// or is exactly . or .. (the review of the M7 plan). Anything else is null:
// the gateway answers every null with one -32602.
const assert = require('assert');
const uri = require('../../lib/mcp/resource-uri');

describe('mcp-contract 25: the module resource URI parser (M7)', () => {
  const notes = uri.compile('notes/{id}');
  const file = uri.compile('files/{name}.json');
  const two = uri.compile('a/{x}/b/{y}');
  const stat = uri.compile('all');

  it('the module and the path are split from the URI, strictly', () => {
    assert.deepStrictEqual(uri.split('countinghouse://m/declares_everything/notes/first'), {slug: 'declares_everything', segments: ['notes', 'first']});
    for (const bad of ['countinghouse://M/x/notes/a', 'Countinghouse://m/x/notes/a', 'countinghouse://r/x', 'countinghouse://m/x', 'countinghouse://m//notes/a',
      'countinghouse://m/X/notes/a', 'countinghouse://m/x-y/notes/a', 'countinghouse://m/x/', 'countinghouse://m/x/notes//a', 'countinghouse://m/x/notes/a/',
      `countinghouse://m/x/${'a'.repeat(2048)}`, 'countinghouse://m/x/notes/a?q=1', 'countinghouse://m/x/notes/a#f', 42, null]) {
      assert.strictEqual(uri.split(bad), null, JSON.stringify(bad));
    }
  });

  it('a path matches a template: literals exactly, each variable within its segment', () => {
    assert.deepStrictEqual(uri.match(notes, ['notes', 'first']), {id: 'first'});
    assert.deepStrictEqual(uri.match(file, ['files', 'report.json']), {name: 'report'});
    assert.deepStrictEqual(uri.match(two, ['a', '1', 'b', '2']), {x: '1', y: '2'});
    assert.deepStrictEqual(uri.match(stat, ['all']), {});
    assert.deepStrictEqual(uri.match(notes, ['notes', '']), {id: ''}, 'an empty variable: the input schema decides');
    for (const [t, segs] of [[notes, ['Notes', 'a']], [notes, ['notes']], [notes, ['notes', 'a', 'b']], [file, ['files', 'report.txt']], [stat, ['al']]]) {
      assert.strictEqual(uri.match(t, segs), null, JSON.stringify(segs));
    }
  });

  // the review of M7: a variable named like an Object.prototype member is
  // the input's own property, never lost on assignment
  it('a variable named __proto__ is an own property of the input', () => {
    const got = uri.match(uri.compile('files/{__proto__}'), ['files', 'abc']);
    assert.ok(Object.prototype.hasOwnProperty.call(got, '__proto__'));
    assert.strictEqual(Object.getOwnPropertyDescriptor(got, '__proto__').value, 'abc');
    assert.strictEqual(JSON.stringify(got), '{"__proto__":"abc"}');
  });

  it('a variable is percent-decoded as UTF-8', () => {
    assert.deepStrictEqual(uri.match(notes, ['notes', 'caf%C3%A9']), {id: 'café'});
    assert.deepStrictEqual(uri.match(notes, ['notes', 'a%20b~c.d_e-f']), {id: 'a b~c.d_e-f'});
  });

  it('a variable that is not unreserved characters and escapes, or does not decode, or decodes to what is refused, matches nothing', () => {
    for (const raw of ['a b', 'a+b', 'a%', 'a%2', 'a%zz', '%C3%28', '%C0%AF', '%ED%A0%80', '%00', '%1F', '%7F', '%C2%80', '%C2%9F',
      '%2F', 'a%2Fb', '%5C', 'a%5cb', '%2E', '%2E%2E', '.', '..', 'a@b', 'a:b', 'a!b', 'é']) {
      assert.strictEqual(uri.match(notes, ['notes', raw]), null, raw);
    }
    assert.deepStrictEqual(uri.match(notes, ['notes', '...']), {id: '...'}, 'only . and .. themselves are path steps');
    assert.deepStrictEqual(uri.match(notes, ['notes', 'a.b']), {id: 'a.b'});
  });

  it('a compiled template gives its full URI template, and a template that is no template compiles to null', () => {
    assert.strictEqual(uri.full('declares_everything', 'notes/{id}'), 'countinghouse://m/declares_everything/notes/{id}');
    for (const bad of ['', '/notes', 'notes/', 'notes//a', 'a/{x}{y}', 'a/{x}/{x}', 'a b']) assert.strictEqual(uri.compile(bad), null, bad);
  });
});
