// Each entry is one route from module code to the module resolver
// (docs/superpowers/specs/2026-11-11-node-floor-shim-design.md, section 3).
// Below Node 24.15 the resolve hooks do not see require.resolve, so these
// are the routes the resolve shim must bring under the sandbox's hooks.
// test/sandbox/39-resolve-shim.js drives them; it checks the outcome
// ("blocked" is the sandbox's refusal, recognised by its message), the
// violation the boundary records, and that no host path comes back.
const Module = module.constructor;

// A require kept from this file's top level, used later in a handler.
const captured = require;

const ROUTES = {
  resolveAbsolute:       (arg) => require.resolve(arg),
  resolveClimb:          (arg) => require.resolve(arg),
  resolvePaths:          (arg) => require.resolve.paths(arg),
  createRequireResolve:  (arg) => require('module').createRequire(__filename).resolve(arg),
  builtinCreateRequire:  (arg) => process.getBuiltinModule('module').createRequire(__filename).resolve(arg),
  capturedResolve:       (arg) => captured.resolve(arg),
  directResolveFilename: (arg) => Module._resolveFilename(arg, module, false),
  replaceResolveFilename: () => {
    Module._resolveFilename = () => '/replaced';
    return require.resolve('./attempt');
  },
  ownFile:               () => require.resolve('./attempt'),
  ownFileDir:            () => require('module').createRequire(`${__dirname}/`).resolve('./attempt')
};

module.exports = async (input) => {
  try {
    const result = await ROUTES[input.what](input.arg);
    return {output: {outcome: 'allowed', code: null, result: result}};
  } catch (e) {
    const blocked = /countinghouse module sandbox/.test(String(e && e.message));
    return {output: {outcome: blocked ? 'blocked' : 'allowed', code: (e && e.code != null) ? String(e.code) : null, result: null}};
  }
};
