// attempt.js -- tries one route to a file outside the module's root
// (input.target, an absolute path) and reports whether its content came back.
const url = require('url');

function result(fn) {
  try {
    const v = fn();
    return (v != null && v.secret === true) ? {outcome: 'read', code: null} : {outcome: 'refused', code: 'NO_CONTENT'};
  } catch (e) {
    return {outcome: 'refused', code: String(e && (e.code || `${e.name}: ${e.message}`.slice(0, 120)))};
  }
}

// countinghouse's own code in the cache: a host path with lib/ in it (either
// separator on Windows), not the module's own (/app/..., or <V>:\app\... on
// Windows, #195)
const libKey = () => Object.keys(require.cache).find((k) => /[\\/]lib[\\/]/.test(k) && !k.startsWith('/app/') && !/^[A-Za-z]:\\app\\/.test(k));

module.exports = async (input) => {
  const target = input.target;
  switch (input.what) {
    case 'parentRequire':
      return {output: result(() => module.parent.require(target))};
    case 'cacheRequire': {
      const key = libKey();
      if (key == null) return {output: {outcome: 'no-key', code: null}};
      return {output: result(() => require.cache[key].require(target))};
    }
    case 'moduleLoad':
      return {output: result(() => module.constructor._load(target, module.parent))};
    case 'protoRequire':
      return {output: result(() => module.constructor.prototype.require.call(module.parent, target))};
    case 'vmImport': {
      // (a vm Script's filename is the module's to choose: since #194's PR 2
      // require.cache names no runtime file, so the test hands one over,
      // as module code could guess one)
      const key = libKey() || input.libFile;
      if (key == null) return {output: {outcome: 'no-key', code: null}};
      const vm = require('vm');
      try {
        const script = new vm.Script(`import(${JSON.stringify(url.pathToFileURL(target).href)}, {with: {type: 'json'}})`,
          {filename: key, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
        const ns = await script.runInThisContext();
        return {output: (ns && ns.default && ns.default.secret === true) ? {outcome: 'read', code: null} : {outcome: 'refused', code: 'NO_CONTENT'}};
      } catch (e) {
        return {output: {outcome: 'refused', code: String(e && e.code)}};
      }
    }
    case 'getter': {
      // Node reads options.paths while resolving and options.encoding while
      // reading a file: a getter for either runs inside the loader's grant
      // window. It tries the module's require and a direct read.
      let seen = null;
      const names = ['paths', 'encoding'];
      names.forEach((n) => Object.defineProperty(Object.prototype, n, {configurable: true, get() {
        if (seen == null) {
          seen = {outcome: 'refused', code: 'BUSY'};
          const viaRequire = result(() => require(target));
          const viaRead = result(() => JSON.parse(require('fs').readFileSync(target, 'utf8')));
          seen = (viaRequire.outcome === 'read' || viaRead.outcome === 'read') ? {outcome: 'read', code: null}
            : {outcome: 'refused', code: `${viaRequire.code}/${viaRead.code}`};
        }
        return undefined;
      }, set(v) {
        // code that assigns the name gets an ordinary own property
        Object.defineProperty(this, n, {value: v, writable: true, configurable: true, enumerable: true});
      }}));
      try {
        delete require.cache[require.resolve('../../lib/helper')];
        require('../../lib/helper');
      } catch (e) {
        // the probe only cares what the getter got
      } finally {
        names.forEach((n) => delete Object.prototype[n]);
      }
      return {output: seen == null ? {outcome: 'not-fired', code: null} : seen};
    }
    case 'moduleScheme':
      // countinghouse's own way of naming module files, tried by the module
      return {output: result(() => require(`countinghouse-module:/../../..${target}`))};
    // F4-1 (a): Node's extension handlers run the load hooks with any path,
    // read for a stand-in module whose _compile keeps the source
    case 'extJs':
      return {output: result(() => {
        let source = null;
        require.extensions['.js']({_compile(src) { source = src; }}, target);
        return source == null ? null : JSON.parse(source);
      })};
    case 'extJson':
      return {output: result(() => {
        const stand = {};
        require.extensions['.json'](stand, target);
        return stand.exports;
      })};
    // the same through a Module of its own: new Module().load(file)
    case 'moduleNewLoad':
      return {output: result(() => {
        const made = new module.constructor(target, null);
        made.load(target);
        return made.exports;
      })};
    // F4-1 (b): Node's createRequire assigns require.resolve, so an accessor
    // on Function.prototype swallows it and answers the resolve hook's own
    // lookup: a path under the module's root, lexically, that climbs out
    case 'resolveAccessor': {
      Object.defineProperty(Function.prototype, 'resolve', {configurable: true,
        get() { return (s) => `${s}/${'../'.repeat(64)}${target.replace(/^\//, '')}`; },
        set(v) { /* swallowed */ }});
      try {
        return {output: result(() => require(`${__dirname}/never-there.js`))};
      } finally {
        delete Function.prototype.resolve;
      }
    }
    // #194's revision 6, item 9: a not-found of the module's own request
    // names the request alone (no require stack, no host parent's path)
    case 'notFoundShape':
      try {
        require('./does-not-exist');
        return {output: {outcome: 'read', code: 'FOUND'}};
      } catch (e) {
        // (an empty require stack, as Node gives one it has none for)
        const exact = e.message === "Cannot find module './does-not-exist'" && Array.isArray(e.requireStack) && e.requireStack.length === 0 && e.code === 'MODULE_NOT_FOUND';
        return {output: {outcome: 'refused', code: exact ? 'EXACT' : `LEAKY: ${String(e.message).slice(0, 200)} ${JSON.stringify(e.requireStack)}`}};
      }
    // a bare name that would reach a file in countinghouse's lib/ (the route
    // NODE_PATH=lib would open): the sandbox's refusal under enforce, a
    // plain not-found otherwise; the target is the name
    case 'libName':
      try {
        require(target);
        return {output: {outcome: 'read', code: 'FOUND'}};
      } catch (e) {
        return {output: {outcome: 'refused', code: /countinghouse module sandbox/.test(String(e && e.message)) ? 'TAGGED' : 'PLAIN'}};
      }
    case 'registerHooks':
      try {
        module.constructor.registerHooks({resolve: (s, c, next) => next(s, c)});
        return {output: {outcome: 'read', code: 'REGISTERED'}};
      } catch (e) {
        return {output: {outcome: 'refused', code: String(e && e.code)}};
      }
    default:
      return {output: {outcome: 'unknown', code: null}};
  }
};
