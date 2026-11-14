// #164: ctx.redis is per module. The main thread puts every key argument of
// every command a module sends under m:<module name>:, the name main loaded
// the module under (never one the worker states), by a key-position table
// covering every allowed command; a command whose keys cannot be found
// statically is refused. Server-free: lib/redis-namespace.js alone.
const assert = require('assert');
const {ALLOWED_COMMANDS} = require('../../lib/redis-api');
const {KEY_POSITIONS, prefixFor, namespaceCommand, unprefixError} = require('../../lib/redis-namespace');
const {safeName} = require('../../lib/module-data');

const P = 'm:mod-a:';

describe('local-kv 03: the per-module Redis namespace (#164)', () => {
  it('every allowed command has a key position, and nothing else does', () => {
    assert.deepStrictEqual(Object.keys(KEY_POSITIONS).sort(), ALLOWED_COMMANDS.slice().sort());
  });

  it('the prefix is m:<module name, URI-encoded>:, and a name that is not one gives none', () => {
    assert.strictEqual(prefixFor('mod-a'), P);
    assert.strictEqual(prefixFor('@scope/pkg'), 'm:%40scope%2Fpkg:');
    // a ':' in a name cannot reach into another module's space: victim:x is
    // not victim's key x:...
    assert.strictEqual(prefixFor('victim:x'), 'm:victim%3Ax:');
    assert.ok(!`${prefixFor('victim:x')}k`.startsWith(prefixFor('victim')));
    for (const bad of [null, undefined, '', 7, {}, 'a\uD800']) assert.strictEqual(prefixFor(bad), null, String(bad));
  });

  it('a module name that is not well-formed Unicode is refused at load', () => {
    assert.strictEqual(safeName('a\uD800'), false);
    assert.strictEqual(safeName('mod-a'), true);
  });

  it('a one-key command: its key is prefixed, its other arguments are not', () => {
    assert.deepStrictEqual(namespaceCommand('get', ['k'], P), {args: [`${P}k`]});
    assert.deepStrictEqual(namespaceCommand('set', ['k', 'v', 'PX', 100], P), {args: [`${P}k`, 'v', 'PX', 100]});
    assert.deepStrictEqual(namespaceCommand('hset', ['h', 'f', 'v'], P), {args: [`${P}h`, 'f', 'v']});
    // hmset(key, {field: value}): the fields as pairs
    assert.deepStrictEqual(namespaceCommand('hmset', ['h', {f: 'v', g: 2}], P), {args: [`${P}h`, 'f', 'v', 'g', 2]});
    assert.deepStrictEqual(namespaceCommand('hmset', ['h', 'f', 'v'], P), {args: [`${P}h`, 'f', 'v']});
    assert.deepStrictEqual(namespaceCommand('zrange', ['z', 0, -1, 'WITHSCORES'], P), {args: [`${P}z`, 0, -1, 'WITHSCORES']});
    // node_redis's array form: one array holding every argument
    assert.deepStrictEqual(namespaceCommand('lpush', [['l', 'a', 'b']], P), {args: [`${P}l`, 'a', 'b']});
  });

  it('a multi-key command: every key is prefixed, in either form', () => {
    assert.deepStrictEqual(namespaceCommand('del', ['a', 'b'], P), {args: [`${P}a`, `${P}b`]});
    assert.deepStrictEqual(namespaceCommand('mget', [['a', 'b', 'c']], P), {args: [`${P}a`, `${P}b`, `${P}c`]});
  });

  it('multi and exec are not available, nor any command a transaction could carry', () => {
    for (const [op, data] of [['multi', [[['set', 'k', '1'], ['get', 'k']]]], ['multi', [[['select', 0], ['exec']]]], ['exec', []],
      ['eval', ['return 1', 0]], ['multi', [[['eval', 'return 1', 0]]]]]) {
      assert.ok(namespaceCommand(op, data, P).refused, `${op} ${JSON.stringify(data)}`);
    }
  });

  it('refused: an unknown command, a command with no key, a key that is not a string or a number', () => {
    for (const op of ['keys', 'scan', 'eval', 'flushall', 'constructor', '__proto__']) assert.ok(namespaceCommand(op, ['x'], P).refused, op);
    assert.ok(namespaceCommand('get', [], P).refused);
    assert.ok(namespaceCommand('del', [], P).refused);
    assert.ok(namespaceCommand('get', [{toString: () => 'x'}], P).refused);
    assert.ok(namespaceCommand('del', ['a', ['b']], P).refused);
    assert.ok(namespaceCommand('get', ['k'], null).refused, 'no namespace: refused, never unprefixed');
  });

  it('a trailing undefined (an absent callback) is not an argument', () => {
    assert.deepStrictEqual(namespaceCommand('del', ['a', 'b', undefined], P), {args: [`${P}a`, `${P}b`]});
    assert.deepStrictEqual(namespaceCommand('get', ['k', undefined, undefined], P), {args: [`${P}k`]});
  });

  it('a key that already looks prefixed stays inside: m:mod-b:k from mod-a is m:mod-a:m:mod-b:k', () => {
    assert.deepStrictEqual(namespaceCommand('get', ['m:mod-b:k'], P), {args: [`${P}m:mod-b:k`]});
  });

  it('an error\'s text loses the prefix', () => {
    assert.strictEqual(unprefixError(`WRONGTYPE at ${P}k and ${P}j`, P), 'WRONGTYPE at k and j');
    assert.strictEqual(unprefixError('plain', P), 'plain');
  });
});
