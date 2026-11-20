'use strict';
// sandbox 71 (C-bare R0): a bare require is CommonJS's own lookup under
// enforce because every stat and package.json read on its path goes
// through Module._stat and Module._readPackage, which Node's loader keeps
// as accessors whose setter replaces the `let` its walk calls
// (lib/internal/modules/cjs/loader.js: 266-267, 477-483 on 22.16; 289-290,
// 524-530 on 24.21; 305-306, 535-541 on 26.13). The reasoning in
// lib/fs-broker/identity.js holds only while that does: on a Node where
// either is no longer an accessor with a setter, this fails -- in CI, not
// silently -- and identity's installation refuses to start under enforce.
const assert = require('assert');
const Module = require('module');

// the check, on any object standing for Module: [] when both are accessors
// with a getter and a setter, configurable; the names that aren't otherwise
const notAccessors = (M) => ['_stat', '_readPackage'].filter((key) => {
  const d = Object.getOwnPropertyDescriptor(M, key);
  return !(d != null && typeof(d.get) === 'function' && typeof(d.set) === 'function' && d.configurable === true);
});

describe('sandbox 71: Module._stat and Module._readPackage are accessors with a setter on this Node (C-bare R0)', () => {
  it(`on ${process.version}`, () => {
    assert.deepStrictEqual(notAccessors(Module), []);
  });
  it('the check fails for a loader where either is plain data, or has no setter', () => {
    const accessor = {get() { return null; }, set() {}, configurable: true};
    const both = Object.defineProperties({}, {_stat: accessor, _readPackage: accessor});
    assert.deepStrictEqual(notAccessors(both), []);
    const data = Object.defineProperties({}, {_stat: {value: () => null, configurable: true}, _readPackage: accessor});
    assert.deepStrictEqual(notAccessors(data), ['_stat']);
    const getterOnly = Object.defineProperties({}, {_stat: accessor, _readPackage: {get() { return null; }, configurable: true}});
    assert.deepStrictEqual(notAccessors(getterOnly), ['_readPackage']);
  });
});
