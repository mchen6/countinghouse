// C-bare R0: the answer checks past Node's judged lookups, each alone.
// Node's own _findPath and _resolveFilename are stood in for, before the
// install, by ones answering a file outside the module root -- as Node
// would were a stat or a realpath ever to lead there -- so each wrapper's
// own check on Node's answer is all that stands: _findPath answers false,
// _resolveFilename a missing module, as for a missing file.
const Module = require('module');
const path = require('path');
const identity = require('../../../lib/fs-broker/identity');

module.exports = async (fs, root, ctx) => {
  const {ch, mod, outside} = ctx.extra;
  const file = path.join(outside, 'f.js');
  // (for the one name asked below only: every other request Node's own)
  const nodeFind = Module._findPath;
  const nodeResolve = Module._resolveFilename;
  Module._findPath = function(request, ...rest) { return request === 'somepkg' ? file : Reflect.apply(nodeFind, this, [request, ...rest]); };
  Module._resolveFilename = function(request, ...rest) { return request === 'somepkg' ? file : Reflect.apply(nodeResolve, this, [request, ...rest]); };
  identity.install({installDir: ch, moduleRoot: mod, mode: ctx.extra.mode, grant: ctx.handled.grant,
    registerHooks: Module.registerHooks, report: () => {}, virtualDrive: process.platform === 'win32' ? 'M' : undefined});
  const code = (fn) => { try { const r = fn(); return r === file ? 'outside' : r; } catch (e) { return `throws ${e.code}`; } };
  return {
    findPathAnswer: code(() => Module._findPath('somepkg', [path.join(mod, 'node_modules')])),
    resolveAnswer: code(() => Module._resolveFilename('somepkg', null))
  };
};
