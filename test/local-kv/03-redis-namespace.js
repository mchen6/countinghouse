// #164: ctx.redis is per module. The main thread puts every key argument of
// every command a module sends under m:<module name>:, the name main loaded
// the module under (never one the worker states), by a key-position table
// covering every allowed command; a command whose keys cannot be found
// statically is refused. Server-free: lib/redis-namespace.js alone.
const assert = require('assert');
const {ALLOWED_COMMANDS} = require('../../lib/redis-api');
const {KEY_POSITIONS, prefixFor, namespaceCommand, unprefixError, unprefixReplies} = require('../../lib/redis-namespace');

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
    for (const bad of [null, undefined, '', 7, {}]) assert.strictEqual(prefixFor(bad), null, String(bad));
  });

  it('a one-key command: its key is prefixed, its other arguments are not', () => {
    assert.deepStrictEqual(namespaceCommand('get', ['k'], P), {args: [`${P}k`]});
    assert.deepStrictEqual(namespaceCommand('set', ['k', 'v', 'PX', 100], P), {args: [`${P}k`, 'v', 'PX', 100]});
    assert.deepStrictEqual(namespaceCommand('hset', ['h', 'f', 'v'], P), {args: [`${P}h`, 'f', 'v']});
    assert.deepStrictEqual(namespaceCommand('hmset', ['h', {f: 'v'}], P), {args: [`${P}h`, {f: 'v'}]});
    assert.deepStrictEqual(namespaceCommand('zrange', ['z', 0, -1, 'WITHSCORES'], P), {args: [`${P}z`, 0, -1, 'WITHSCORES']});
    // node_redis's array form: one array holding every argument
    assert.deepStrictEqual(namespaceCommand('lpush', [['l', 'a', 'b']], P), {args: [`${P}l`, 'a', 'b']});
  });

  it('a multi-key command: every key is prefixed, in either form', () => {
    assert.deepStrictEqual(namespaceCommand('del', ['a', 'b'], P), {args: [`${P}a`, `${P}b`]});
    assert.deepStrictEqual(namespaceCommand('mget', [['a', 'b', 'c']], P), {args: [`${P}a`, `${P}b`, `${P}c`]});
  });

  it('multi: every queued command is put in the namespace; one that cannot be is refused, and so is the whole transaction', () => {
    assert.deepStrictEqual(namespaceCommand('multi', [[['set', 'k', '1'], ['del', 'a', 'b'], ['get', 'k']]], P),
      {commands: [['set', `${P}k`, '1'], ['del', `${P}a`, `${P}b`], ['get', `${P}k`]]});
    for (const bad of [[[['keys', '*']]], [[['exec']]], [[['multi', []]]], [[['flushall']]], [['set', 'k']], [[]], [], [[['get']]]]) {
      assert.ok(namespaceCommand('multi', bad, P).refused, JSON.stringify(bad));
    }
  });

  it('refused: exec on its own, an unknown command, a command with no key, a key that is not a string or a number', () => {
    assert.ok(namespaceCommand('exec', [], P).refused);
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
    assert.deepStrictEqual(namespaceCommand('multi', [[['get', 'k']], undefined], P), {commands: [['get', `${P}k`]]});
  });

  it('a key that already looks prefixed stays inside: m:mod-b:k from mod-a is m:mod-a:m:mod-b:k', () => {
    assert.deepStrictEqual(namespaceCommand('get', ['m:mod-b:k'], P), {args: [`${P}m:mod-b:k`]});
  });

  it('an error\'s text loses the prefix, and so does an error among a transaction\'s replies', () => {
    assert.strictEqual(unprefixError(`WRONGTYPE at ${P}k and ${P}j`, P), 'WRONGTYPE at k and j');
    assert.strictEqual(unprefixError('plain', P), 'plain');
    const replies = unprefixReplies(['OK', new Error(`bad ${P}k`), 'v'], P);
    assert.deepStrictEqual([replies[0], replies[1].message, replies[2]], ['OK', 'bad k', 'v']);
  });
});
