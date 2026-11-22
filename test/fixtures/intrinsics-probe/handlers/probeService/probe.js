'use strict';
// test/sandbox/62: the lockdown's checks run on what it took before module
// code loaded. One change at a time: CHANGES below names it, replaces it
// with something that answers what a module would want, runs every attempt,
// then puts it back. Adding an intrinsic is one line.
const path = require('path');
const url = require('url');
const Module = require('module');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const OWN_FILE = path.join(ROOT, 'own.txt');
const OWN_DATA = path.join(ROOT, 'own-data.js');
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
// a change left in place across calls (input.persist): its undo
let persisted = null;
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
// what a setter put on a prototype is handed: ports it saw, counted; and a
// list of paths it is handed (a grant's) gets this host path appended
let portsSeen = 0;
// and a runtime token (a call token: 32 hex characters, lib/call-tokens.js):
// as a value, or an object's own token (or its args' or data's) up to two
// levels down, or in the bytes behind a typed array
let tokensSeen = 0;
const RegExpExec = Function.prototype.call.bind(RegExp.prototype.exec);
const TOKEN = /^[0-9a-f]{32}$/;
const isToken = (v) => typeof(v) === 'string' && v.length === 32 && RegExpExec(TOKEN, v) !== null;
const ownValue = (o, key) => { const d = ObjectGetOwnPropertyDescriptor(o, key); return d != null ? d.value : undefined; };
const holdsToken = (o, depth = 0) => {
  if (isToken(o)) return true;
  if (o == null || typeof(o) !== 'object' || depth > 2) return false;
  try {
    return holdsToken(ownValue(o, 'token'), depth + 1) || holdsToken(ownValue(o, 'args'), depth + 1) || holdsToken(ownValue(o, 'data'), depth + 1);
  } catch (e) {
    return false;
  }
};
const anyHoldsToken = (list) => { for (let i = 0; i < list.length; i++) if (holdsToken(list[i])) return true; return false; };
// a run of exactly 32 hex characters in an ArrayBuffer (the first 1 MiB)
const Uint8ArrayCtor = Uint8Array;
const isHex = (c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 102);
const bytesHoldToken = (ab) => {
  if (!(ab instanceof ArrayBuffer)) return false;
  const u8 = new Uint8ArrayCtor(ab);
  const n = u8.length < 1048576 ? u8.length : 1048576;
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (isHex(u8[i])) { run++; continue; }
    if (run === 32) return true;
    run = 0;
  }
  return run === 32;
};
// a function handed over is wrapped: a token among its arguments is seen
const watching = (fn) => function(...a) {
  if (anyHoldsToken(a)) tokensSeen++;
  return reflectApply(fn, this, a);
};
let appendPath = null;
const ArrayIsArray = Array.isArray;
const MessagePortProto = MessagePort.prototype;
const portOn = Object.getPrototypeOf(MessagePort.prototype).on;
const portPost = MessagePort.prototype.postMessage;
const addListener = EventTarget.prototype.addEventListener;
const emitterOn = require('events').prototype.on;
const ObjectIsPrototypeOf = Function.prototype.call.bind(Object.prototype.isPrototypeOf);
const isPort = (v) => v != null && typeof(v) === 'object' && ObjectIsPrototypeOf(MessagePortProto, v);
// a runtime object by its own fields (a channel, a query, a client, the
// worker's interface or peer state, a device)
const looksRuntime = (o) => o != null && typeof(o) === 'object' &&
  ['pending', 'port', 'ci', 'cdifInterface', 'deviceManager', 'workerMessage', '_composition', '_compositionSettled'].some((k) => ObjectGetOwnPropertyDescriptor(o, k) !== undefined);
const setterOn = (proto, key) => replace(proto, key, {configurable: true, enumerable: false,
  get() { return undefined; },
  set(v) {
    if (isPort(v) || isPort(this)) portsSeen++;
    if (holdsToken(this) || holdsToken(v)) tokensSeen++;
    if (typeof(v) === 'function') v = watching(v);
    ObjectDefineProperty(this, key, {value: v, writable: true, enumerable: true, configurable: true});
    if (appendPath != null && ArrayIsArray(this) && typeof(v) === 'string' && v[0] === '/' && v !== appendPath) {
      let there = false;
      for (let i = 0; i < this.length; i++) if (this[i] === appendPath) there = true;
      if (!there) ObjectDefineProperty(this, this.length, {value: appendPath, writable: true, enumerable: true, configurable: true});
    }
  }});
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
  // the file broker's routing and grants, and its loader hook's format
  'Array.prototype.every': () => swap(Array.prototype, 'every', () => true),
  'Array.prototype.map': () => swap(Array.prototype, 'map', () => ['/']),
  'Array.prototype.concat': () => swap(Array.prototype, 'concat', () => ['/']),
  'JSON.parse': () => swap(JSON, 'parse', () => ({type: 'module'})),
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
  // a setter on each of Array.prototype's first indexes, and on keys the
  // runtime's containers use on Object.prototype: each records a port it is
  // handed and passes the value on as an own property
  // a port's methods: each counts a port it is handed (the lockdown fixes them)
  'NodeEventTarget.prototype.on': () => swap(Object.getPrototypeOf(MessagePort.prototype), 'on', function(...a) { if (ObjectIsPrototypeOf(MessagePortProto, this)) portsSeen++; return reflectApply(portOn, this, a); }),
  'MessagePort.prototype.postMessage': () => swap(MessagePort.prototype, 'postMessage', function(...a) { portsSeen++; return reflectApply(portPost, this, a); }),
  // not fixed (EventEmitter is not a port's): still handed no port
  'EventEmitter.prototype.on': () => swap(require('events').prototype, 'on', function(...a) { if (ObjectIsPrototypeOf(MessagePortProto, this)) portsSeen++; return reflectApply(emitterOn, this, a); }),
  'EventTarget.prototype.addEventListener': () => swap(EventTarget.prototype, 'addEventListener', function(...a) { if (ObjectIsPrototypeOf(MessagePortProto, this)) portsSeen++; return reflectApply(addListener, this, a); }),
  'Array.prototype index setters': () => {
    const undo = [];
    for (let k = 0; k < 8; k++) undo[k] = setterOn(Array.prototype, StringCtor(k));
    return () => { for (let k = 0; k < 8; k++) undo[k](); };
  },
  'Object.prototype setters': () => {
    const keys = ['code', 'message', 'origin', 'uri', 'proxy', 'followRedirect', 'roots', 'files', 'data', 'id',
      'command', 'category', 'port', 'dataBuffer', 'errorBuffer', 'headOnly', 'token', 'usageCall'];
    const undo = [];
    for (let k = 0; k < keys.length; k++) undo[k] = setterOn(Object.prototype, keys[k]);
    return () => { for (let k = 0; k < keys.length; k++) undo[k](); };
  },
  // what the runtime keeps a call's token in, or passes one through
  'Map.prototype.set/get/has/delete': () => watchMethods(Map.prototype, ['set', 'get', 'has', 'delete']),
  'Array.prototype.push/shift/unshift/splice/forEach': () => watchMethods(Array.prototype, ['push', 'shift', 'unshift', 'splice', 'forEach']),
  'Object.assign': () => watchMethods(Object, ['assign']),
  'TypedArray buffer/byteOffset/byteLength, ArrayBuffer.prototype.slice': () => {
    const TA = Object.getPrototypeOf(Uint8Array.prototype);
    const bufferOf = ObjectGetOwnPropertyDescriptor(TA, 'buffer').get;
    let inside = false;
    const scanning = (get) => function() {
      if (!inside) {
        inside = true;
        try { if (bytesHoldToken(reflectApply(bufferOf, this, []))) tokensSeen++; } catch (e) { /* not a typed array */ } finally { inside = false; }
      }
      return reflectApply(get, this, []);
    };
    const undo = ['buffer', 'byteOffset', 'byteLength'].map((key) => getter(TA, key, scanning(ObjectGetOwnPropertyDescriptor(TA, key).get)));
    const slice = ArrayBuffer.prototype.slice;
    undo[undo.length] = swap(ArrayBuffer.prototype, 'slice', function(...a) { if (bytesHoldToken(this)) tokensSeen++; return reflectApply(slice, this, a); });
    return () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); };
  },
  // a container's next numeric keys (a reply queue's ids): a callback put
  // there is wrapped, so a token it is called with is seen
  'Object.prototype numeric-key setters': () => {
    const undo = [];
    for (let k = 0; k < 8; k++) undo[k] = setterOn(Object.prototype, StringCtor(k));
    return () => { for (let k = 0; k < 8; k++) undo[k](); };
  },
  // the keys Node assigns on a port it sets up (a transferred one included)
  'Object.prototype port-symbol setters': () => {
    const keys = Object.getOwnPropertySymbols(new EventTarget());
    keys[keys.length] = Symbol.for('nodejs.internal.kCurrentlyReceivingPorts');
    const undo = keys.map((key) => setterOn(Object.prototype, key));
    return () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); };
  },
  // getters on Object.prototype for fields the runtime reads off its own
  // messages, options and objects: a read of one that is absent falls
  // through to here, with the object (a call's args, a reply, the device) as
  // `this`
  'Object.prototype getters (runtime fields read)': () => {
    const keys = ['inputBytes', 'jobID', 'wantsProgress', 'httpHeaders', 'billingPending', 'ctx', 'billingKey', 'caller', 'usageCall',
      '_ctxServiceClients', '_verdictWaiters', '_composition', 'peerChannels', 'peerCalleeChannels', 'peerDeviceWorkerMap', 'pendingPeerInvokes', 'limits', 'mainChecked'];
    const undo = keys.map((key) => getter(Object.prototype, key, function() {
      if (holdsToken(this) || looksRuntime(this)) tokensSeen++;
      return undefined;
    }));
    return () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); };
  },
  // what the runtime's emitters inherit (not fixed: modules extend it)
  'EventEmitter.prototype emit/on/once/addListener/removeListener/listenerCount': () =>
    watchMethods(require('events').prototype, ['emit', 'on', 'once', 'addListener', 'removeListener', 'listenerCount']),
  // the runtime's own files as require.cache holds them: the entry's
  // exports swapped for a copy whose functions watch what they are handed
  'require.cache entries swapped (call-limits, hop-input, port-scope, peer-channel, peer-worker, chutil-facade)': () => {
    const undo = [];
    forRuntimeFiles(CACHE_FILES, (entry) => {
      const before = entry.exports;
      const copy = (typeof(before) === 'function') ? watching(before) : {};
      for (const key of Object.keys(before)) {
        const v = before[key];
        copy[key] = (typeof(v) === 'function') ? watching(v) : v;
      }
      undo[undo.length] = replace(entry, 'exports', {value: copy, writable: true, configurable: true, enumerable: true});
    });
    return () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); };
  },
  // the same files' exports objects, and the runtime's classes' prototypes,
  // changed in place (the runtime fixes them at boot)
  'runtime exports and prototypes replaced in place': () => {
    const undo = [];
    forRuntimeFiles(CACHE_FILES.concat(['worker-message']), (entry) => {
      const targets = [entry.exports];
      if (typeof(entry.exports) === 'function' && entry.exports.prototype != null) targets[targets.length] = entry.exports.prototype;
      if (entry.exports != null && entry.exports.methods != null) targets[targets.length] = entry.exports.methods;
      for (const obj of targets) {
        for (const key of Object.getOwnPropertyNames(obj)) {
          const d = ObjectGetOwnPropertyDescriptor(obj, key);
          if (d == null || typeof(d.value) !== 'function' || key === 'constructor') continue;
          undo[undo.length] = swap(obj, key, watching(d.value));
        }
      }
    });
    return () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); };
  },
};

// obj's methods, each watching what it is handed (as this or arguments):
// a port counted, a token counted
function watchMethods(obj, keys) {
  const undo = [];
  for (const key of keys) {
    const orig = obj[key];
    undo[undo.length] = swap(obj, key, function(...a) {
      if (isPort(this)) portsSeen++;
      for (let i = 0; i < a.length; i++) if (isPort(a[i])) portsSeen++;
      if (holdsToken(this) || anyHoldsToken(a) || (ArrayIsArray(this) && anyHoldsToken(this))) tokensSeen++;
      return reflectApply(orig, this, a);
    });
  }
  return () => { for (let i = undo.length - 1; i >= 0; i--) undo[i](); };
}

// the runtime's files (lib/<name>.js, never the module's own) as the
// module's require.cache holds them
const CACHE_FILES = ['call-limits', 'hop-input', 'port-scope', 'peer-channel', 'peer-worker', 'chutil-facade'];
let cacheReachable = false;
function forRuntimeFiles(names, each) {
  // (the runtime's modules from the test's probe: since #194's PR 2 module
  // code's own require.cache holds its own files only)
  const handed = globalThis[Symbol.for('countinghouse.test.runtime')];
  const cache = (handed != null && handed.modules != null) ? handed.modules : ((require.cache != null) ? require.cache : (module.constructor != null ? module.constructor._cache : null));
  if (cache == null) return;
  for (const file of Object.keys(cache)) {
    if (StringCtor(file).startsWith(ROOT)) continue;
    for (const name of names) {
      if (!file.endsWith(`${path.sep}lib${path.sep}${name}.js`)) continue;
      cacheReachable = true;
      each(cache[file]);
    }
  }
}

// what fn answered, as a string, or its refusal
const valueOf = (fn) => {
  try {
    return {outcome: 'reached', value: StringCtor(fn())};
  } catch (e) {
    return {outcome: 'refused', code: e != null && e.code != null ? StringCtor(e.code) : null};
  }
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
  // A change left in place across calls: installed by one call, kept while
  // the runtime handles the next ones (their own tokens, its replies), then
  // put back by a third, which answers what it saw.
  if (input.persist === 'install') {
    if (persisted != null) persisted();
    changed = false;
    cacheReachable = false;
    portsSeen = 0;
    tokensSeen = 0;
    persisted = CHANGES[input.change]();
    return {output: {installed: changed, cacheReachable}};
  }
  if (input.persist === 'collect') {
    const undo = persisted;
    persisted = null;
    if (undo != null) undo();
    return {output: {tokensSeen, portsSeen}};
  }
  // an ordinary call's work, each carrying its token to the main thread: a
  // remote call (refused there: none declared), ctx.usage and ctx.ask
  if (input.route === 'work') {
    const settle = (p) => PromiseCtor.resolve(p).then(() => 'answered', (e) => StringCtor(e && e.code));
    const attempt = (fn) => { try { return settle(fn()); } catch (e) { return PromiseCtor.resolve(StringCtor(e && (e.code != null ? e.code : e.name))); } };
    const remote = await attempt(() => ctx.call('remote:nothing-declared/tool', {}));
    const usage = await attempt(() => ctx.usage());
    const ask = await attempt(() => ctx.ask('ch-sandbox-62-question', {}));
    return {output: {remote, usage, ask}};
  }
  // a port as util.inspect shows it (console.log's way)
  if (input.route === 'inspect') {
    const c = new MessageChannel();
    let shown;
    try {
      shown = require('util').inspect(c.port1);
      shown = StringCtor(shown).startsWith('MessagePort') ? 'MessagePort' : StringCtor(shown).slice(0, 40);
    } catch (e) {
      shown = `threw ${StringCtor(e && e.name)}`;
    } finally {
      c.port1.close();
    }
    return {output: {inspect: shown}};
  }
  // The worker's own ports after the lockdown fixed their methods: a line on
  // stdout (Node's stdio port) and this reply (the worker's own port).
  if (input.route === 'stdio') {
    process.stdout.write(`ch-sandbox-62-stdio-${input.marker}\n`);
    return {output: {written: true}};
  }
  // What shares EventTarget.prototype with a port, as a module may use it
  if (input.route === 'abort') {
    const out = {};
    const c = new AbortController();
    let heard = false;
    c.signal.addEventListener('abort', () => { heard = true; });
    c.abort();
    out.controller = heard && c.signal.aborted;
    out.timeout = await new Promise((resolve) => { const s = AbortSignal.timeout(5); s.addEventListener('abort', () => resolve(s.aborted)); });
    const c2 = new AbortController();
    const timer = require('timers/promises').setTimeout(60000, null, {signal: c2.signal}).then(() => 'elapsed', (e) => e.name);
    c2.abort();
    out.timers = await timer;
    const target = new EventTarget();
    let got = null;
    target.addEventListener('ping', (e) => { got = e.type; });
    target.dispatchEvent(new Event('ping'));
    out.eventTarget = got;
    // the fixed methods as a module meets them: an assignment on an
    // instance throws (strict code), a definition on it, a subclass's own
    // method and an accessor (onabort) work
    const assigned = new EventTarget();
    try { assigned.addEventListener = () => {}; out.instanceAssign = 'assigned'; } catch (e) { out.instanceAssign = StringCtor(e && e.name); }
    const defined = new EventTarget();
    ObjectDefineProperty(defined, 'addEventListener', {value: () => 'own', configurable: true});
    out.ownDefine = defined.addEventListener('x', () => {});
    class Sub extends EventTarget { addEventListener() { return 'sub'; } }
    out.subclass = new Sub().addEventListener('x', () => {});
    const c3 = new AbortController();
    let onabort = false;
    c3.signal.onabort = () => { onabort = true; };
    c3.abort();
    out.onabort = onabort;
    out.fetch = await fetch('http://ch-sandbox-62.invalid/', {signal: AbortSignal.timeout(2000)}).then(() => 'answered', (e) => (e != null && e.name != null ? 'rejected' : 'rejected'));
    return {output: out};
  }
  // ctx.ask's values copied by the runtime while a setter on Object.prototype
  // has the value's key: the runtime's own copy is never written through it
  // (the question is not declared, so the ask is refused either way)
  if (input.route === 'ask') {
    const KEY = 'chSandbox62AskValue';
    let hits = 0;
    const undoSetter = replace(Object.prototype, KEY, {configurable: true, enumerable: false,
      get() { return undefined; },
      set(v) { hits++; ObjectDefineProperty(this, KEY, {value: v, writable: true, enumerable: true, configurable: true}); }});
    let asked = null;
    try {
      const values = {};
      ObjectDefineProperty(values, KEY, {value: 'ch-sandbox-62-value', writable: true, enumerable: true, configurable: true});
      asked = ctx.ask('ch-sandbox-62-question', values);
    } catch (e) {
      asked = PromiseCtor.reject(e);
    } finally {
      undoSetter();
    }
    const answer = await asked.then(() => 'answered', (e) => StringCtor(e && e.code));
    return {output: {setterHits: hits, answer}};
  }
  // A read grant (an imported CommonJS file's) opens and reads read-only.
  if (input.route === 'grant-write') {
    const h2 = (await import('../../h2.cjs')).default;
    return {output: {write: h2.tryWrite(), truncate: h2.tryTruncate(), length: h2.length(), fdOps: h2.fdOps()}};
  }
  // The loader's package.json read, called with no directory while a setter
  // on Array.prototype's index 0 turns the directory it is handed into a
  // host one: what is checked is what is read.
  if (input.route === 'read-package') {
    const M = module.constructor;
    const readPackage = M != null ? M._readPackage : undefined;
    if (typeof(readPackage) !== 'function') return {output: {readPackage: 'unreachable'}};
    // (the first write only: Node's own arrays after it keep their values)
    let swapped = 0;
    const undoSetter = replace(Array.prototype, '0', {configurable: true, enumerable: false,
      get() { return undefined; },
      set(v) { ObjectDefineProperty(this, '0', {value: swapped++ === 0 ? input.hostDir : v, writable: true, enumerable: true, configurable: true}); }});
    let got = null;
    try {
      const r = readPackage();
      got = r == null ? null : {exists: r.exists === true, name: r.name != null ? StringCtor(r.name) : null};
    } catch (e) {
      got = {threw: StringCtor(e && e.code)};
    } finally {
      undoSetter();
    }
    return {output: {readPackage: got}};
  }
  const result = {builtins: {}, getBuiltin: {}};
  let host = null;
  handed = [];
  changed = false;
  cacheReachable = false;
  portsSeen = 0;
  tokensSeen = 0;
  appendPath = input.hostFile;
  const undo = CHANGES[input.change]();
  let undone = false;
  try {
    // a lasting grant taken with the change in place (the first import of
    // the module's own CommonJS file)
    if (input.change === 'Array.prototype index setters') {
      try { await import('../../h.cjs'); } catch (e) { result.importFailed = StringCtor(e && e.message); }
    }
    for (let i = 0; i < input.builtins.length; i++) {
      const b = input.builtins[i];
      result.builtins[b] = outcome(() => require(b));
      result.getBuiltin[b] = outcome(() => process.getBuiltinModule(b));
    }
    result.outsidePath = outcome(() => CHUtil.loadFile(input.outsidePath));
    // a file outside the module's root, by require
    result.runtimeFile = outcome(() => require(input.runtimeFile));
    // the file broker: a host file outside every grant, and a real
    // descriptor number
    result.hostFile = outcome(() => fs.readFileSync(input.hostFile, 'utf8'));
    result.realFd = outcome(() => fs.fstatSync(input.realFd));
    result.hostStat = outcome(() => fs.statSync(input.hostFile));
    // what is checked is what is used: a value that answers one path the
    // first time it is read and the host file after, and a URL whose own
    // href accessor names the host file
    let reads = 0;
    const turning = {[Symbol.toPrimitive]: () => (reads++ === 0 ? OWN_DATA : input.hostFile)};
    result.toPrimitiveLoad = valueOf(() => CHUtil.loadFile(turning));
    // (inside the attempt: a change can make the URL constructor throw)
    result.ownHrefRead = valueOf(() => {
      const ownHref = new URL(`file://${OWN_DATA}`);
      ObjectDefineProperty(ownHref, 'href', {get: () => `file://${input.hostFile}`, configurable: true});
      return fs.readFileSync(ownHref, 'utf8');
    });
    // (enforce serves the reduced module; its createRequire checks the path)
    result.createRequireOutside = outcome(() => require('module').createRequire(input.outsidePath));
    // allowed: the guard hands these on to the original
    result.ownFile = outcome(() => CHUtil.loadFile(OWN_FILE));
    result.allowedBuiltin = outcome(() => process.getBuiltinModule('path'));
    // the runtime's handle listing, ports filtered out: never handed to a setter
    result.activeHandles = outcome(() => process._getActiveHandles());
    // a message to the main thread that carries the call's token (a remote
    // call: refused there, since no remote is declared)
    // (a change that breaks Node's own URL in this realm can make the call
    // throw where it is made: the module's own loss, and the attempts go on)
    try {
      result.remoteCall = ctx.call('remote:nothing-declared/tool', {}).then(() => 'answered', (e) => StringCtor(e && e.code));
    } catch (e) {
      result.remoteCall = StringCtor(e && (e.code != null ? e.code : e.name));
    }
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
  result.remoteCall = await result.remoteCall;
  result.handed = handed;
  result.undone = undone;
  result.changed = changed;
  result.portsSeen = portsSeen;
  result.tokensSeen = tokensSeen;
  result.cacheReachable = cacheReachable;
  appendPath = null;
  return {output: result};
};
// the changes' names, for test/sandbox/62 (it requires this file to read them)
module.exports.CHANGE_NAMES = Object.freeze(Object.keys(CHANGES));
