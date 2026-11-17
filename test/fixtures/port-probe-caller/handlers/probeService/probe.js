'use strict';
// test/sandbox/63: a direct peer channel's port reaches a worker after its
// module code has loaded, and Node sets it up then. Every method that could
// be handed it is replaced (where the lockdown lets it be) by one that
// counts a port it is handed, as `this` or as an argument; then the worker's
// first peer call runs, so the channel is brokered with the replacements in
// place. No replacement may ever see a port.
const EventEmitter = require('events');

const ObjectDefineProperty = Object.defineProperty;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ReflectApply = Reflect.apply;
const PortProto = MessagePort.prototype;
const isPort = Function.prototype.call.bind(Object.prototype.isPrototypeOf, PortProto);

let portsSeen = 0;
const seen = [];
const counting = (name, orig) => function(...a) {
  let port = (this != null && typeof(this) === 'object' && isPort(this));
  for (let i = 0; i < a.length; i++) if (a[i] != null && typeof(a[i]) === 'object' && isPort(a[i])) port = true;
  if (port) { portsSeen++; seen[seen.length] = name; }
  return ReflectApply(orig, this, a);
};

const NodeEventTargetProto = ObjectGetPrototypeOf(PortProto);
const TARGETS = [
  ['EventEmitter.prototype.on', EventEmitter.prototype, 'on'],
  ['EventEmitter.prototype.addListener', EventEmitter.prototype, 'addListener'],
  ['EventEmitter.prototype.once', EventEmitter.prototype, 'once'],
  ['EventEmitter.prototype.emit', EventEmitter.prototype, 'emit'],
  ['NodeEventTarget.prototype.on', NodeEventTargetProto, 'on'],
  ['NodeEventTarget.prototype.addListener', NodeEventTargetProto, 'addListener'],
  ['EventTarget.prototype.addEventListener', EventTarget.prototype, 'addEventListener'],
  ['EventTarget.prototype.dispatchEvent', EventTarget.prototype, 'dispatchEvent'],
  ['MessagePort.prototype.postMessage', PortProto, 'postMessage'],
  ['MessagePort.prototype.start', PortProto, 'start'],
  ['MessagePort.prototype.close', PortProto, 'close']
];

module.exports = async (input, ctx) => {
  const changed = {};
  const undo = [];
  for (let i = 0; i < TARGETS.length; i++) {
    const [name, obj, key] = TARGETS[i];
    const before = ObjectGetOwnPropertyDescriptor(obj, key);
    changed[name] = false;
    if (before == null || typeof(before.value) !== 'function') continue;
    try {
      ObjectDefineProperty(obj, key, {value: counting(name, before.value), writable: true, configurable: true, enumerable: before.enumerable});
      changed[name] = true;
      undo[undo.length] = () => ObjectDefineProperty(obj, key, before);
    } catch (e) {
      // fixed by the lockdown
    }
  }
  const calls = [];
  try {
    for (let n = 0; n < 2; n++) {
      try {
        const r = await ctx.call('hop-input-callee/sinkService.count', {});
        calls[calls.length] = (r != null && r.output != null && typeof(r.output.runs) === 'number') ? 'answered' : JSON.stringify(r);
      } catch (e) {
        calls[calls.length] = String(e && e.code);
      }
    }
  } finally {
    for (let i = undo.length - 1; i >= 0; i--) undo[i]();
  }
  return {output: {changed, calls, portsSeen, seen}};
};
