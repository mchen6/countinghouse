'use strict';
// test/sandbox/62: the lockdown's checks run on what it took before module
// code loaded. One change at a time: CHANGES below names it, replaces it
// with something that answers what a module would want, runs every attempt,
// then puts it back. Adding an intrinsic is one line.
const path = require('path');
const url = require('url');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const OWN_FILE = path.join(ROOT, 'own.txt');
// this file's own, taken before any change
const ReflectApply = Reflect.apply;
const ObjectDefineProperty = Object.defineProperty;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const PromiseCtor = Promise;
const StringCtor = String;

// Functions handed to a replaced call, apply or Reflect method while an
// attempt ran: a check that calls an original that way hands it over.
let handed = [];
const record = (fn) => { if (typeof(fn) === 'function') handed[handed.length] = fn.name; };

// Whether the change could be made at all: the lockdown fixes some objects
// (path, url, URL.prototype, Module.isBuiltin), and then the attempts run
// with nothing changed.
let changed = false;
// obj[key] replaced by value; -> undo
const replace = (obj, key, descriptor) => {
  const before = ObjectGetOwnPropertyDescriptor(obj, key);
  try {
    ObjectDefineProperty(obj, key, descriptor);
  } catch (e) {
    return () => {};
  }
  changed = true;
  return () => (before !== undefined ? ObjectDefineProperty(obj, key, before) : delete obj[key]);
};
const swap = (obj, key, value) => replace(obj, key, {value, writable: true, configurable: true, enumerable: false});
const getter = (obj, key, get) => replace(obj, key, {get, configurable: true, enumerable: false});
const reflectApply = Reflect.apply;
const reflectConstruct = Reflect.construct;
const inside = path.join(ROOT, 'inside.js');

// name -> () => undo. Each answers what would let a check pass.
const CHANGES = {
  'Set.prototype.has': () => swap(Set.prototype, 'has', () => { return true; }),
  'Map.prototype.get': () => swap(Map.prototype, 'get', () => { return undefined; }),
  'Array.prototype.some': () => swap(Array.prototype, 'some', () => { return true; }),
  'Array.prototype.includes': () => swap(Array.prototype, 'includes', () => { return true; }),
  'Array.prototype.indexOf': () => swap(Array.prototype, 'indexOf', () => { return 0; }),
  'String.prototype.startsWith': () => swap(String.prototype, 'startsWith', () => { return true; }),
  'String.prototype.endsWith': () => swap(String.prototype, 'endsWith', () => { return true; }),
  'String.prototype.toLowerCase': () => swap(String.prototype, 'toLowerCase', () => { return 'localhost'; }),
  'String.prototype.replace': () => swap(String.prototype, 'replace', function() { return StringCtor(this); }),
  'String.prototype.slice': () => swap(String.prototype, 'slice', () => { return 'path'; }),
  'RegExp.prototype.test': () => swap(RegExp.prototype, 'test', () => { return true; }),
  'RegExp.prototype.exec': () => swap(RegExp.prototype, 'exec', () => { return null; }),
  'Function.prototype.call': () => swap(Function.prototype, 'call', function(...a) { record(this); return ReflectApply(this, a[0], a.slice(1)); }),
  'Function.prototype.apply': () => swap(Function.prototype, 'apply', function(self, a) { record(this); return ReflectApply(this, self, a || []); }),
  'Reflect.apply': () => swap(Reflect, 'apply', (fn, self, a) => { record(fn); return reflectApply(fn, self, a); }),
  'Reflect.construct': () => swap(Reflect, 'construct', (fn, a, nt) => { record(fn); return reflectConstruct(fn, a, nt); }),
  'Object.keys': () => swap(Object, 'keys', () => { return []; }),
  'URL hostname': () => getter(URL.prototype, 'hostname', () => { return 'granted.example'; }),
  'url.fileURLToPath': () => swap(url, 'fileURLToPath', () => { return inside; }),
  'path.resolve': () => swap(path, 'resolve', () => { return inside; }),
  'path.relative': () => swap(path, 'relative', () => { return 'inside.js'; }),
  'Module.isBuiltin': () => swap(Module, 'isBuiltin', () => { return false; }),
  // iteration, reflection and conversion a check could reach
  'Array.prototype[Symbol.iterator]': () => swap(Array.prototype, Symbol.iterator, function* () { yield '/'; }),
  '%ArrayIteratorPrototype%.next': () => swap(Object.getPrototypeOf([][Symbol.iterator]()), 'next', () => ({done: true, value: undefined})),
  'String.prototype[Symbol.iterator]': () => swap(String.prototype, Symbol.iterator, function* () { yield '/'; }),
  'Object.getOwnPropertyDescriptor': () => swap(Object, 'getOwnPropertyDescriptor', () => ({value: 'DEVICE_OFFLINE', writable: true, enumerable: true, configurable: true})),
  'Object.defineProperty': () => swap(Object, 'defineProperty', (o) => o),
  'Object.hasOwn': () => swap(Object, 'hasOwn', () => true),
  'Object.freeze': () => swap(Object, 'freeze', (o) => o),
  'globalThis.String': () => swap(globalThis, 'String', () => 'own.txt'),
  'Function.prototype.toString': () => swap(Function.prototype, 'toString', () => 'function () { [native code] }'),
  'Object.prototype getters (href, host, ports, net)': () => {
    const undo = ['href', 'host', 'ports', 'net'].map((key) => getter(Object.prototype, key, () => (key === 'ports' || key === 'net' ? [] : 'granted.example')));
    return () => undo.forEach((u) => u());
  },
  'WeakMap.prototype.get/has': () => {
    const a = swap(WeakMap.prototype, 'get', () => ({code: 'DEVICE_OFFLINE', message: 'm', origin: 'runtime'}));
    const b = swap(WeakMap.prototype, 'has', () => true);
    return () => { b(); a(); };
  },
  'WeakSet.prototype.has/add': () => {
    const a = swap(WeakSet.prototype, 'has', () => true);
    const b = swap(WeakSet.prototype, 'add', function() { return this; });
    return () => { b(); a(); };
  },
};

const outcome = (fn) => {
  try {
    const v = fn();
    return v === undefined ? {outcome: 'refused', code: 'undefined'} : {outcome: 'reached'};
  } catch (e) {
    return {outcome: 'refused', code: e != null && e.code != null ? StringCtor(e.code) : null, message: StringCtor(e && e.message)};
  }
};

const ObjectHasOwn = Object.hasOwn;

module.exports = async (input, ctx) => {
  if (!ObjectHasOwn(CHANGES, input.change)) return {output: {unknown: input.change}};
  // A refusal the runtime issues (a ctx.call to nothing composed), taken
  // with the change in place and thrown back: answered with the code the
  // runtime issued, whatever the change.
  if (input.rethrow === true) {
    let refusal = null;
    changed = false;
    const undoIssued = CHANGES[input.change]();
    try {
      await ctx.call('nothing-composed/noService.none', {}).catch((e) => { refusal = e; });
    } finally {
      undoIssued();
    }
    throw refusal != null ? refusal : new Error('no refusal');
  }
  const result = {builtins: {}, getBuiltin: {}};
  let host = null;
  handed = [];
  changed = false;
  const undo = CHANGES[input.change]();
  let undone = false;
  try {
    for (let i = 0; i < input.builtins.length; i++) {
      const b = input.builtins[i];
      result.builtins[b] = outcome(() => require(b));
      result.getBuiltin[b] = outcome(() => process.getBuiltinModule(b));
    }
    result.outsidePath = outcome(() => CHUtil.loadFile(input.outsidePath));
    // a file outside the module's root, by require (the test holds this
    // until the file broker's checks are on captured intrinsics too)
    result.runtimeFile = outcome(() => require(input.runtimeFile));
    // (enforce serves the reduced module; its createRequire checks the path)
    result.createRequireOutside = outcome(() => require('module').createRequire(input.outsidePath));
    // allowed: the guard hands these on to the original
    result.ownFile = outcome(() => CHUtil.loadFile(OWN_FILE));
    result.allowedBuiltin = outcome(() => process.getBuiltinModule('path'));
    host = new PromiseCtor((resolve) => {
      try {
        CHUtil.request({uri: `http://${input.host}/`, method: 'GET', timeout: 3000}, (err) => resolve(err != null ? {outcome: 'refused', code: err.code != null ? StringCtor(err.code) : null} : {outcome: 'reached'}));
      } catch (e) {
        resolve({outcome: 'refused', code: e != null && e.code != null ? StringCtor(e.code) : null, message: StringCtor(e && e.message)});
      }
    });
  } finally {
    undo();
    undone = true;
  }
  result.host = await host;
  result.handed = handed;
  result.undone = undone;
  result.changed = changed;
  return {output: result};
};
