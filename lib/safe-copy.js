'use strict';
// One way to copy a module's declaration (the high review of #447, 7): each
// key defined, never assigned, so a "__proto__" key stays a key and never
// becomes a prototype; and nothing copied when nothing changes, so a caller
// can tell (and an unchanged spec is handed on as it is).
const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const own = (o, k, v) => Object.defineProperty(o, k, {value: v, writable: true, enumerable: true, configurable: true});

// obj's own enumerable keys, with `changes` (an object of key -> value) in
// place of theirs; obj itself when every change is the value it holds
function copyWith(obj, changes) {
  const keys = Object.keys(changes);
  if (keys.every((k) => Object.hasOwn(obj, k) && obj[k] === changes[k])) return obj;
  const out = {};
  for (const k of Object.keys(obj)) own(out, k, Object.hasOwn(changes, k) ? changes[k] : obj[k]);
  return out;
}

module.exports = {isObject, own, copyWith};
