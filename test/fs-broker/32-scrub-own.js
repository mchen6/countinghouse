// F4-1's follow-ups: an error module code is handed has every own value
// scrubbed by its data (lib/fs-broker/identity.js scrubOwn): strings
// rewritten, the errors and objects it carries (a cause, an
// AggregateError's errors, a SystemError's info) in turn, never through a
// getter or a Proxy, a cycle once, and past the bounds cut, never left as
// they were. Server-free.
const assert = require('assert');
const {scrubOwn} = require('../../lib/fs-broker/identity');

const HOST = '/srv/host-root.invalid/mod';
const rewrite = (t) => t.split(HOST).join('/app');

describe('fs-broker 32: an error\'s own values, scrubbed by their data', () => {
  it('every own string, enumerable or not, symbol-keyed too', () => {
    const e = new Error(`open '${HOST}/x.js'`);
    Object.defineProperty(e, 'hidden', {value: `${HOST}/h`, enumerable: false, writable: true, configurable: true});
    const sym = Symbol('where');
    e[sym] = `${HOST}/s`;
    e.path = `${HOST}/x.js`;
    scrubOwn(e, rewrite);
    assert.deepStrictEqual([e.message, e.hidden, e[sym], e.path], ["open '/app/x.js'", '/app/h', '/app/s', '/app/x.js']);
    assert.strictEqual(Object.getOwnPropertyDescriptor(e, 'hidden').enumerable, false);
  });

  it('a cause chain and a SystemError-like info, in turn; past three levels cut', () => {
    const e = new Error('top');
    e.info = {path: `${HOST}/i`, dest: `${HOST}/d`};
    let at = e;
    for (let i = 0; i < 5; i++) { at.cause = new Error(`${HOST}/c${i}`); at = at.cause; }
    scrubOwn(e, rewrite);
    assert.deepStrictEqual(e.info, {path: '/app/i', dest: '/app/d'});
    assert.deepStrictEqual([e.cause.message, e.cause.cause.message, e.cause.cause.cause.message], ['/app/c0', '/app/c1', '/app/c2']);
    assert.strictEqual(e.cause.cause.cause.cause, undefined, 'past the bound: cut, not left raw');
  });

  it('an AggregateError\'s errors, each scrubbed; past sixteen cut', () => {
    const errors = [];
    for (let i = 0; i < 20; i++) errors.push(new Error(`${HOST}/e${i}`));
    const e = new AggregateError(errors, 'many');
    scrubOwn(e, rewrite);
    assert.strictEqual(e.errors[0].message, '/app/e0');
    assert.strictEqual(e.errors[15].message, '/app/e15');
    assert.strictEqual(e.errors.length, 16, 'past the bound: cut to sixteen');
    // (a hundred: cut to sixteen too, never dropped whole)
    const hundred = new AggregateError(Array.from({length: 100}, (x, i) => new Error(`${HOST}/h${i}`)), 'more');
    scrubOwn(hundred, rewrite);
    assert.deepStrictEqual([hundred.errors.length, hundred.errors[0].message], [16, '/app/h0']);
  });

  it('a nested error\'s stack its first line only, no requireStack; an accessor cut, never called', () => {
    const e = new Error('top');
    const cause = new Error(`${HOST}/c`);
    cause.requireStack = [`${HOST}/p.js`, '/srv/runtime.invalid/lib/x.js'];
    e.cause = cause;
    let read = 0;
    const sys = new Error('sys');
    Object.defineProperty(sys, 'path', {get() { read += 1; return `${HOST}/p`; }, enumerable: true, configurable: true});
    e.errors = [sys];
    scrubOwn(e, rewrite);
    assert.deepStrictEqual([cause.stack, cause.requireStack], ['Error: /app/c', []]);
    // (a nested TypeError's line as the outermost's is written: class, code)
    const typed = Object.assign(new TypeError(`${HOST}/t`), {code: 'ERR_X'});
    const holder = new Error('h');
    holder.cause = typed;
    scrubOwn(holder, rewrite);
    assert.strictEqual(typed.stack, 'TypeError [ERR_X]: /app/t');
    // (an object not an error: its stack a string like any other)
    const like = {stack: `${HOST}/x.js:1`};
    const outer = new Error('o');
    outer.cause = like;
    scrubOwn(outer, rewrite);
    assert.strictEqual(like.stack, '/app/x.js:1');
    assert.strictEqual(Object.getOwnPropertyDescriptor(sys, 'path').value, undefined, 'an accessor is cut');
    assert.strictEqual(read, 0);
  });

  it('fails closed: a frozen holder, a Buffer, a function, too many keys -- cut, or answered undefined', () => {
    const frozen = Object.freeze({path: `${HOST}/f`});
    const e = new Error('top');
    e.info = frozen;
    e.data = Buffer.from(`${HOST}/b`);
    e.fn = Object.assign(() => 0, {where: `${HOST}/fn`});
    const wide = {};
    for (let i = 0; i < 100; i++) wide[`k${i}`] = HOST;
    e.wide = wide;
    scrubOwn(e, rewrite);
    assert.deepStrictEqual([e.info, e.data, e.fn, e.wide], [undefined, undefined, undefined, undefined]);
    const sealed = Object.freeze(new Error(`${HOST}/s`));
    assert.strictEqual(scrubOwn(sealed, rewrite), undefined, 'one that can\'t be rewritten is answered undefined');
    // (rejected once, rejected wherever else it is held)
    const twice = new Error('two');
    const shared = Object.freeze({path: `${HOST}/shared`});
    twice.cause = shared;
    twice.info = shared;
    scrubOwn(twice, rewrite);
    assert.deepStrictEqual([twice.cause, twice.info], [undefined, undefined]);
  });

  it('never a getter, never a Proxy, a cycle once', () => {
    let read = 0;
    const e = new Error('g');
    Object.defineProperty(e, 'lazy', {get() { read += 1; return `${HOST}/g`; }, configurable: true});
    const arr = [];
    Object.defineProperty(arr, 0, {get() { read += 1; return new Error(HOST); }, enumerable: true, configurable: true});
    e.errors = arr;
    let trapped = 0;
    e.cause = new Proxy(new Error(HOST), {ownKeys() { trapped += 1; return []; }, get() { trapped += 1; return undefined; }, getOwnPropertyDescriptor() { trapped += 1; return undefined; }});
    e.self = e;
    scrubOwn(e, rewrite);
    assert.deepStrictEqual([read, trapped], [0, 0]);
    assert.strictEqual(e.cause, undefined, 'a Proxy is dropped, never read');
    assert.strictEqual(e.self, e, 'a cycle is no second pass');
  });
});
