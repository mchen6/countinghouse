// A countinghouse parent importing an ES-module dependency after set-options,
// under live enforce (review I4): the ESM loader reads the target with
// openSync + readSync, which must be served under the loader's read grant.
const Module = require('module');
const path = require('path');
const identity = require('../../../lib/fs-broker/identity');

module.exports = async (fs, root, ctx) => {
  const {ch, mod} = ctx.extra;
  identity.install({installDir: ch, moduleRoot: mod, mode: 'enforce', grant: ctx.handled.grant,
    registerHooks: Module.registerHooks, report: () => {}});
  return require(path.join(ch, 'lib', 'parent.js'))();
};
