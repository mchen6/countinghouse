'use strict';
// sandbox 67 (#194's PR 1, revision 6's item 4): a static pin beside
// sandbox 66's run. What a module's worker loads at boot is followed from
// its entry files by their top-level requires, dependencies included; in
// that closure, a require() or import() inside a function would load
// something after the lockdown, where module code can stand between it and
// Node's loader. Each one is a finding unless it is reviewed below, with why
// it never runs in a locked worker (the main thread's branch, a refused
// option...). A dependency bump that adds one fails here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const espree = require('espree');

const ROOT = path.join(__dirname, '..', '..');
// a file's name as the reviewed entries spell it: relative to the repo, and a
// dependency as node_modules/..., also where node_modules is a link to
// another tree (a worktree's), by its real path
const ROOT_REAL = (() => {
  try { return fs.realpathSync(ROOT); } catch (e) { return ROOT; }
})();
const NODE_MODULES = (() => {
  try { return fs.realpathSync(path.join(ROOT, 'node_modules')); } catch (e) { return path.join(ROOT, 'node_modules'); }
})();
const relOf = (file) => {
  let real = file;
  try { real = fs.realpathSync(file); } catch (e) { /* as given */ }
  const fromModules = path.relative(NODE_MODULES, real);
  if (!fromModules.startsWith('..') && !path.isAbsolute(fromModules)) return path.join('node_modules', fromModules).split(path.sep).join('/');
  // (the repo's own files by its real path too: a checkout reached through
  // a link names them the same)
  const fromRoot = path.relative(ROOT_REAL, real);
  if (!fromRoot.startsWith('..') && !path.isAbsolute(fromRoot)) return fromRoot.split(path.sep).join('/');
  return path.relative(ROOT, file).split(path.sep).join('/');
};
// what a worker boots from: the lean worker; the lockdown, loaded at
// set-options, whose wrappers run after it; a validation worker's
// validator; postman-request, loaded at set-options for a module that
// declares net
const ENTRIES = [path.join(ROOT, 'lib', 'lean-worker.js'), path.join(ROOT, 'lib', 'module-lockdown.js'),
  path.join(ROOT, 'lib', 'module-validator.js'), require.resolve('postman-request', {paths: [ROOT]})];

// [file relative to ROOT (a regex), the request (a regex), why]
const MAIN = 'the main thread\'s branch: never runs in a worker';
// an entry's 5th: the number of sites it covers (checked: a new site fails).
// an entry's 4th: FOLLOW (what it loads can run in a worker: followed, as
// is every unreviewed load and every entry with no 4th), or NOT_IN_WORKER
// (a main thread's branch, or a path no worker takes: not followed, since
// what it loads never loads in a worker)
const FOLLOW = 'follow';
const NOT_IN_WORKER = 'not in a worker';
const REVIEWED = [
  // set-options and boot, before the lockdown
  [/^lib\/lean-worker\.js$/, /^\.\/fs-broker\/(identity|patch)$/, 'boot and set-options: before the lockdown', FOLLOW, 1],
  [/^lib\/lean-worker\.js$/, /^\.\/module-lockdown$/, 'set-options: the lockdown itself', FOLLOW, 1],
  [/^lib\/fs-broker\/identity\.js$/, /^(fs|\.\/roots)$/, 'the main thread\'s code roots, and insideHostFor at load', FOLLOW, 3],
  [/^lib\/fs-broker\/identity\.js$/, /^os$/, 'install: at set-options, before the lockdown', FOLLOW, 1],
  [/^lib\/fs-broker\/patch\.js$/, /^\.\/roots$/, 'install: at boot', FOLLOW, 1],
  [/^lib\/lean-worker\.js$/, /^postman-request$/, 'warm, at set-options before the lockdown, for a module that declares net', FOLLOW, 2],
  [/^lib\/lean-worker\.js$/, /^\.\/declarations$/, 'warm, at boot in a validation worker (validateOnly)', FOLLOW, 1],
  [/^lib\/module-lockdown\.js$/, /^(crypto|dgram|http|http2|net|tls|tty|util)$/, 'install (set-options, before module code) and the handle probes at load', FOLLOW, 12],
  // postman-request on first use: a module that declares net has it from
  // set-options; with no net, enforce refuses every request in the
  // lockdown's wrapper before it is reached, and audit loads it then, by
  // design (ruling (b), the spec's Revision 6 item 11)
  [/^lib\/(chutil-facade|countinghouse-util)\.js$/, /^postman-request$/, 'CHUtil.request: preloaded with net; otherwise ruling (b)', FOLLOW, 2],
  [/^lib\/service-client\.js$/, /^postman-request$/, 'a remote http client only: never made in a worker (its constructor refuses; lib/query-device.js makes none)', NOT_IN_WORKER, 1],
  [/^lib\/schema-safety\.js$/, /^\.\/declarations$/, 'checkSchema: the validator\'s (a validation worker, warmed; lib/validator-worker.js runs no module code)', FOLLOW, 1],
  // the main thread's branches in files a worker shares
  [/^lib\/cli-options\.js$/, /^(\.\/call-limits|\.\/settings-ceiling|\.\/settings-tool)$/, 'outputCeilingNow: a worker returns before (isMainThread)', NOT_IN_WORKER, 3],
  [/^lib\/cli-options\.js$/, /^(crypto|os|\.\/store\/resources-path|\.\/win-acl)$/, 'option parsing: the main thread\'s, and a worker\'s at boot and set-options', FOLLOW, 5],
  [/^lib\/call-limits\.js$/, /^(\.\/session-settings|\.\/settings-ceiling|\.\/settings-tool)$/, MAIN, NOT_IN_WORKER, 3],
  [/^lib\/countinghouse-util\.js$/, /^\.\/single-thread-facade$/, MAIN, NOT_IN_WORKER, 1],
  [/^lib\/countinghouse-device\.js$/, /^\.\/tool-generation$/, 'a device\'s spec replaced: the main thread\'s', NOT_IN_WORKER, 1],
  [/^lib\/handler-ctx\.js$/, /^(\.\/identity|\.\/module-ask|\.\/redis-api|\.\/remote|\.\/usage\/query)$/, MAIN, NOT_IN_WORKER, 5],
  [/^lib\/logger\.js$/, /^bunyan$/, 'createLogger: the main thread\'s logger', NOT_IN_WORKER, 1],
  [/^lib\/logger\.js$/, /^(\.\/thread-info|\.\/worker-logger)$/, 'ready(): a worker\'s logger is made at boot, so it never runs there', FOLLOW, 1],
  [/^lib\/peer-worker\.js$/, /^\.\/countinghouse-util$/, MAIN, NOT_IN_WORKER, 1],
  [/^lib\/query-device\.js$/, /^\.\/countinghouse-device$/, MAIN, NOT_IN_WORKER, 1],
  [/^lib\/redis-api\.js$/, /^(\.\/redis-namespace|\.\/store)$/, 'single-thread mode and the main thread\'s client', NOT_IN_WORKER, 2],
  [/^lib\/service-client\.js$/, /^\.\/user-auth$/, MAIN, NOT_IN_WORKER, 1],
  [/^lib\/session\.js$/, /^\.\/countinghouse-util$/, 'recordMeteredCall: a worker returns before (thread-info)', NOT_IN_WORKER, 1],
  [/^lib\/session\.js$/, /^\.\/failed-call-log$/, 'logAPICall\'s failure log: main thread only (thread-info)', NOT_IN_WORKER, 1],
  [/^lib\/store\.js$/, /^(\.\/countinghouse-error|crypto|\.\/job-control|\.\/job-control-local|\.\/local-kv|\.\/logger|\.\/metering\/local-provider|\.\/metering\/redis-provider|path|redis|\.\/redis-resilient|\.\/store\/blobs|\.\/store\/json-file)$/,
    // (+1, B-j1: jobClients, the Redis job runner's own clients, main thread only)
    'the store is made on the main thread; a worker reaches it over its channel', NOT_IN_WORKER, 22],
  // (+1: ./call-tokens, a device query's answer noting the call's refusal, under isMainThread === true)
  [/^lib\/worker-message\.js$/, /^(\.\/logger|\.\/worker-output|\.\/call-tokens)$/, 'the main thread\'s end of a worker', NOT_IN_WORKER, 6],
  // the settings file's, through the settings tool: guarded by the thread
  // the file loaded on (mainThreadAtLoad); a validation worker loads
  // module-settings for the declaration's rules only (#426)
  [/^lib\/module-settings\.js$/, /^\.\/settings-tool$/, 'storedFor / stateFor: the main thread\'s only (mainThreadAtLoad, taken at load)', NOT_IN_WORKER, 2],
  // dependencies: code that runs at the library's own load
  [/^node_modules\/stream-length\/node_modules\/bluebird\/js\/main\/[a-z_]+\.js$/, /^\.\/[a-z_0-9]+(\.js)?$/,
    'bluebird\'s own files: each exports a setup function that its promise.js calls once, at bluebird\'s load', FOLLOW, 72],
  [/^node_modules\/debug\/src\/node\.js$/, /^(fs|net)$/, 'createWritableStdioStream: at its load', FOLLOW, 2],
  [/^node_modules\/socks-proxy-agent\/node_modules\/debug\/src\/common\.js$/, /^ms$/, 'setup(): at its load', FOLLOW, 1],
  [/^node_modules\/tweetnacl\/nacl-fast\.js$/, /^crypto$/, 'an IIFE at its load', FOLLOW, 1],
  [/^node_modules\/json-schema-ref-parser\/node_modules\/es6-promise\/dist\/es6-promise\.js$/, /^vertx$/,
    'attemptVertx (as r): only where Node\'s process.nextTick is missing; Node picks it at load', NOT_IN_WORKER, 1],
  // lazy-require's holder: the one load each lazy(name) makes, a finding of
  // its own above unless warmed at a worker's boot
  [/^lib\/lazy-require\.js$/, /^<dynamic>$/, 'the holder\'s first use: each lazy(name) is checked above (warmed, or reviewed)', FOLLOW, 1],
  // set-options, before the lockdown: bcrypt-pbkdf along sshpk's chain
  [/^lib\/lean-worker\.js$/, /^(<dynamic>|http-signature|sshpk|bcrypt-pbkdf)$/, 'warmSshpkBcrypt: set-options, before the lockdown, with postman-request', FOLLOW, 4],
  // dependencies: what a worker never reaches, or reaches harmlessly
  [/^node_modules\/uuid-1345\/index\.js$/, /^macaddress$/, 'v1 uuids only: a worker makes v5 (lib/call-address.js)', NOT_IN_WORKER, 1],
  [/^node_modules\/sshpk\/lib\/formats\/ssh-private\.js$/, /^bcrypt-pbkdf$/,
    'an encrypted OpenSSH key (httpSignature): bcrypt-pbkdf is warmed with postman-request at set-options (lib/lean-worker.js warmSshpkBcrypt), so no file is loaded then; the resolve and the require.cache read that remain after the lockdown are PR 2\'s (its moved cache), by the reviewer\'s ruling', FOLLOW, 2],
  [/^node_modules\/@postman\/tough-cookie\/lib\/utilHelper\.js$/, /^util$/,
    'a module\'s own cookie jar (MemoryCookieStore): what it gets is only used to inspect that jar', FOLLOW, 1]
];

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
function parse(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
  for (const sourceType of ['script', 'module']) {
    try { return espree.parse(text, {ecmaVersion: 'latest', sourceType, range: true, loc: true}); } catch (e) { /* the other */ }
  }
  return null;
}
// a call of lazy-require's warm('x'), or of lazy('x') (lib/lazy-require.js)
const callOf = (node, name) => node.type === 'CallExpression' && node.arguments.length === 1 && node.arguments[0].type === 'Literal' &&
  typeof(node.arguments[0].value) === 'string' &&
  ((node.callee.type === 'Identifier' && node.callee.name === name) || (node.callee.type === 'MemberExpression' && node.callee.property.name === name));
// the names every worker warms at boot: a statement of its own at
// lean-worker's top level, run whatever the worker is. A lazy('x') of one is
// taken from lazy-require's holder, never Node's loader; a warm under a
// condition (postman-request with net, the validator's in a validation
// worker) or inside a function warms nothing for the other workers, so a
// lazy() of its name is a finding, and so is that warm itself (below)
let WARMED = null;
// a createRequire(...) call (module.createRequire, or one destructured)
const isCreateRequire = (node) => node != null && node.type === 'CallExpression' &&
  ((node.callee.type === 'Identifier' && node.callee.name === 'createRequire') ||
   (node.callee.type === 'MemberExpression' && node.callee.property.name === 'createRequire'));
// a request as written: a string literal or a template with no expression;
// anything else is '<dynamic>' (a finding wherever it is inside a function)
const literalOf = (arg) => {
  if (arg == null) return '<dynamic>';
  if (arg.type === 'Literal' && typeof(arg.value) === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) return arg.quasis[0].value.cooked;
  return '<dynamic>';
};
const each = (node, fn) => {
  if (node == null || typeof(node.type) !== 'string') return;
  fn(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => each(c, fn));
    else if (v != null && typeof(v) === 'object' && typeof(v.type) === 'string') each(v, fn);
  }
};
// Every way a file can load something: require('x'), a name bound to
// require (const r = require) or to what createRequire returns,
// createRequire(...)('x'), module.require('x'), process.getBuiltinModule('x')
// and import('x'), with whether it sits in a function; and every lazy('x')
// (lib/lazy-require.js), a load on first use unless warmed, and every warm
// that is not an unconditional top-level statement. kind: 'require' (a
// plain require, followed when at load) or what else it is.
function requiresOf(ast) {
  const out = [];
  const topWarms = topLevelWarms(ast);
  const loaders = new Set(['require']);
  for (let round = 0; round < 3; round++) {
    each(ast, (node) => {
      const bind = (id, init) => {
        if (id == null || id.type !== 'Identifier' || init == null) return;
        if ((init.type === 'Identifier' && loaders.has(init.name)) || isCreateRequire(init)) loaders.add(id.name);
      };
      if (node.type === 'VariableDeclarator') bind(node.id, node.init);
      if (node.type === 'AssignmentExpression') bind(node.left, node.right);
    });
  }
  const visit = (node, inFunction) => {
    if (node == null || typeof(node.type) !== 'string') return;
    const here = inFunction || FUNCTIONS.has(node.type);
    if (node.type === 'CallExpression') {
      const c = node.callee;
      let kind = null;
      if (c.type === 'Identifier' && loaders.has(c.name)) kind = c.name === 'require' ? 'require' : `require (as ${c.name})`;
      else if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'module' && c.property.name === 'require') kind = 'module.require';
      else if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'process' && c.property.name === 'getBuiltinModule') kind = 'getBuiltinModule';
      else if (isCreateRequire(c)) kind = 'createRequire()';
      // a resolution on its own is a runtime resolve too (_resolveFilename)
      else if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && loaders.has(c.object.name) && c.property.name === 'resolve') kind = 'require.resolve';
      if (kind != null) {
        const request = literalOf(node.arguments[0]);
        // at load, every form with a literal request is followed (an alias:
        // js-yaml's _require('esprima')); at load they run before any lockdown
        if (inFunction || request !== '<dynamic>') out.push({request, inFunction, kind, line: node.loc.start.line});
      }
    }
    if (callOf(node, 'lazy') && !WARMED.has(node.arguments[0].value)) {
      out.push({request: node.arguments[0].value, inFunction: true, kind: 'lazy', line: node.loc.start.line});
    }
    if (callOf(node, 'warm') && !topWarms.has(node)) {
      out.push({request: node.arguments[0].value, inFunction: true, kind: 'warm', line: node.loc.start.line});
    }
    // import() settles later, wherever it is written: always a finding
    if (node.type === 'ImportExpression') {
      out.push({request: literalOf(node.source), inFunction: true, kind: 'import', line: node.loc.start.line});
    }
    // an ESM file's static imports and re-exports: loaded with it
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && node.source != null) {
      out.push({request: literalOf(node.source), inFunction: false, kind: 'import', line: node.loc.start.line});
    }
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => visit(c, here));
      else if (v != null && typeof(v) === 'object' && typeof(v.type) === 'string') visit(v, here);
    }
  };
  visit(ast, false);
  return out;
}

// the warm('x') calls that are statements of their own at a file's top level
function topLevelWarms(ast) {
  return new Set(ast.body.filter((st) => st.type === 'ExpressionStatement' && callOf(st.expression, 'warm')).map((st) => st.expression));
}
WARMED = new Set([...topLevelWarms(parse(path.join(ROOT, 'lib', 'lean-worker.js')))].map((call) => call.arguments[0].value));

describe('sandbox 67: no require inside a function in a worker\'s boot closure (a static pin)', function() {
  this.timeout(120000);
  it('every require or import inside a function there is reviewed, with why it never runs in a locked worker, site by site', () => {
    const seen = new Set();
    const queue = ENTRIES.slice();
    const unparsed = [];
    const findings = [];
    // the sites each reviewed entry covers: a new one with the same file and
    // request fails as surely as a new request (each entry's 5th, its count)
    const tally = REVIEWED.map(() => 0);
    // how each file was reached (PIN67_WHY=<part of a path> prints the chain)
    const via = new Map();
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file) || !file.endsWith('.js') && !file.endsWith('.cjs') && !file.endsWith('.mjs')) continue;
      seen.add(file);
      const ast = parse(file);
      const fileRel = relOf(file);
      if (ast == null) { unparsed.push(fileRel); continue; }
      for (const r of requiresOf(ast)) {
        if (Module.isBuiltin(r.request) && !r.inFunction) continue;
        const rel = fileRel;
        const at = r.inFunction ? REVIEWED.findIndex(([f, q]) => f.test(rel) && q.test(r.request)) : -1;
        if (r.inFunction) {
          if (at < 0) findings.push(`${rel}:${r.line}: ${r.kind}('${r.request}')`);
          else tally[at] += 1;
        }
        // followed wherever it is (a function's load included), unless it
        // never runs in a worker: what it loads is scanned too
        if (r.inFunction && at >= 0 && REVIEWED[at][3] === NOT_IN_WORKER) continue;
        if (r.request === '<dynamic>' || Module.isBuiltin(r.request)) continue;
        let target = null;
        try { target = require.resolve(r.request, {paths: [path.dirname(file)]}); } catch (e) { continue; }
        if (!Module.isBuiltin(target)) {
          if (!via.has(target)) via.set(target, `${fileRel}:${r.line}${r.inFunction ? ' (in a function)' : ''}`);
          queue.push(target);
        }
      }
    }
    if (typeof(process.env.PIN67_WHY) === 'string') {
      for (const f of seen) {
        if (!path.relative(ROOT, f).includes(process.env.PIN67_WHY)) continue;
        const chain = [path.relative(ROOT, f)];
        for (let at = f; via.has(at) && chain.length < 40;) { const from = via.get(at); chain.push(from); at = path.join(ROOT, from.replace(/:.*$/, '')); }
        console.log(chain.join('\n  <- '));
      }
    }
    if (process.env.PIN67_COUNTS === '1') REVIEWED.forEach((e, i) => console.log(`${i}\t${tally[i]}\t${e[0]} ${e[1]}`));
    assert.deepStrictEqual(unparsed, [], 'files the pin could not read');
    assert.deepStrictEqual(findings.sort(), [], `a require inside a function, not reviewed (${findings.length}):\n  ${findings.sort().join('\n  ')}`);
    const counted = REVIEWED.map((e, i) => (e[4] === tally[i] ? null : `${e[0]} ${e[1]}: ${tally[i]} sites, reviewed ${e[4]}`)).filter((x) => x != null);
    assert.deepStrictEqual(counted, [], 'a reviewed entry covers a different number of sites');
  });
});
