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

const libKey = () => Object.keys(require.cache).find((k) => k.includes('/lib/') && !k.startsWith('/app/'));

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
      const key = libKey();
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
