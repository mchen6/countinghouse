// Under enforce, the loader's own disk lookups (Module._stat, _findPath,
// _resolveFilename, _readPackage, findPackageJSON) answer "missing" for a
// path outside the module root and countinghouse's code (plan 3 sweep).
const Module = require('module');
const path = require('path');
const url = require('url');
const identity = require('../../../lib/fs-broker/identity');

module.exports = async (fs, root, ctx) => {
  const {ch, mod, outside} = ctx.extra;
  identity.install({installDir: ch, moduleRoot: mod, mode: ctx.extra.mode, grant: ctx.handled.grant,
    registerHooks: Module.registerHooks, report: () => {}});
  const code = (fn) => { try { return fn(); } catch (e) { return `throws ${e.code}`; } };
  const file = path.join(outside, 'f.js');
  return {
    statOutsideFile: Module._stat(file),
    statOutsideDir: Module._stat(outside),
    statModuleFile: Module._stat(path.join(mod, 'm.js')),
    findPathOutside: code(() => Module._findPath(file, [''])),
    findPathMissing: code(() => Module._findPath(path.join(outside, 'none.js'), [''])),
    resolveOutside: code(() => Module._resolveFilename(file, null)),
    resolveMissing: code(() => Module._resolveFilename(path.join(outside, 'none.js'), null)),
    readPackageOutside: code(() => Module._readPackage(outside).exists),
    findPackageJSONOutside: code(() => Module.findPackageJSON('./f.js', url.pathToFileURL(path.join(outside, 'x.js')).href)),
    moduleRequire: code(() => require(path.join(mod, 'm.js')))
  };
};
