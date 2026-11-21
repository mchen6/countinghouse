'use strict';
// In-process tests that require heavy runtime libs inside a case (or a
// hook with mocha's 2 s default) pay a lib's first load there: 0.4-2.7 s
// cold, more under load, past the timeout. preloadLibs(names) is a before()
// body that loads them once, under its own bound, so a case's own require
// hits the cache. The bound stays finite (10 s): a load that grows that slow
// is still reported, not absorbed.
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib');

function preloadLibs(names, boundMs = 10000) {
  return function() {
    this.timeout(boundMs);
    for (const name of names) require(path.join(LIB, name));
  };
}

module.exports = {preloadLibs};
