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
// what a worker boots from: the lean worker; the lockdown, loaded at
// set-options, whose wrappers run after it; a validation worker's
// validator; postman-request, loaded at set-options for a module that
// declares net
const ENTRIES = [path.join(ROOT, 'lib', 'lean-worker.js'), path.join(ROOT, 'lib', 'module-lockdown.js'),
  path.join(ROOT, 'lib', 'module-validator.js'), require.resolve('postman-request', {paths: [ROOT]})];

// [file relative to ROOT (a regex), the request (a regex), why]
const MAIN = 'the main thread\'s branch: never runs in a worker';
// an entry's 4th: what it loads can run in a worker, so it is followed
const FOLLOW = 'follow';
const REVIEWED = [
  // set-options and boot, before the lockdown
  [/^lib\/lean-worker\.js$/, /^\.\/fs-broker\/(identity|patch)$/, 'boot and set-options: before the lockdown'],
  [/^lib\/lean-worker\.js$/, /^\.\/module-lockdown$/, 'set-options: the lockdown itself'],
  [/^lib\/fs-broker\/identity\.js$/, /^(fs|\.\/roots)$/, 'the main thread\'s code roots, and insideHostFor at load'],
  [/^lib\/fs-broker\/identity\.js$/, /^os$/, 'install: at set-options, before the lockdown'],
  [/^lib\/fs-broker\/patch\.js$/, /^\.\/roots$/, 'install: at boot'],
  [/^lib\/lean-worker\.js$/, /^postman-request$/, 'warm, at set-options before the lockdown, for a module that declares net', FOLLOW],
  [/^lib\/lean-worker\.js$/, /^\.\/declarations$/, 'warm, at boot in a validation worker (validateOnly)', FOLLOW],
  [/^lib\/module-lockdown\.js$/, /^(crypto|dgram|http|http2|net|tls|tty|util)$/, 'install (set-options, before module code) and the handle probes at load'],
  // postman-request on first use: a module that declares net has it from
  // set-options; with no net, enforce refuses every request in the
  // lockdown's wrapper before it is reached, and audit loads it then, by
  // design (ruling (b), the spec's Revision 6 item 11)
  [/^lib\/(chutil-facade|countinghouse-util)\.js$/, /^postman-request$/, 'CHUtil.request: preloaded with net; otherwise ruling (b)'],
  [/^lib\/service-client\.js$/, /^postman-request$/, 'a remote http client only: none is made (lib/query-device.js passes isRemoteService false)'],
  [/^lib\/schema-safety\.js$/, /^\.\/declarations$/, 'checkSchema: the validator\'s (a validation worker, warmed; lib/validator-worker.js runs no module code)'],
  // the main thread's branches in files a worker shares
  [/^lib\/cli-options\.js$/, /^(\.\/call-limits|\.\/settings-ceiling|\.\/settings-tool)$/, 'outputCeilingNow: a worker returns before (isMainThread)'],
  [/^lib\/cli-options\.js$/, /^(crypto|os|\.\/store\/resources-path|\.\/win-acl)$/, 'option parsing: the main thread\'s, and a worker\'s at boot and set-options'],
  [/^lib\/call-limits\.js$/, /^(\.\/session-settings|\.\/settings-ceiling|\.\/settings-tool)$/, MAIN],
  [/^lib\/countinghouse-util\.js$/, /^\.\/single-thread-facade$/, MAIN],
  [/^lib\/countinghouse-device\.js$/, /^\.\/tool-generation$/, 'a device\'s spec replaced: the main thread\'s'],
  [/^lib\/handler-ctx\.js$/, /^(\.\/identity|\.\/module-ask|\.\/redis-api|\.\/remote|\.\/usage\/query)$/, MAIN],
  [/^lib\/logger\.js$/, /^bunyan$/, 'createLogger: the main thread\'s logger'],
  [/^lib\/logger\.js$/, /^(\.\/thread-info|\.\/worker-logger)$/, 'ready(): a worker\'s logger is made at boot, so it never runs there'],
  [/^lib\/peer-worker\.js$/, /^\.\/countinghouse-util$/, MAIN],
  [/^lib\/query-device\.js$/, /^\.\/countinghouse-device$/, MAIN],
  [/^lib\/redis-api\.js$/, /^(\.\/redis-namespace|\.\/store)$/, 'single-thread mode and the main thread\'s client'],
  [/^lib\/service-client\.js$/, /^\.\/user-auth$/, MAIN],
  [/^lib\/session\.js$/, /^\.\/countinghouse-util$/, 'recordMeteredCall: a worker returns before (thread-info)'],
  [/^lib\/store\.js$/, /^(\.\/countinghouse-error|crypto|\.\/job-control|\.\/job-control-local|\.\/local-kv|\.\/logger|\.\/metering\/local-provider|\.\/metering\/redis-provider|path|redis|\.\/redis-resilient|\.\/store\/blobs|\.\/store\/json-file)$/,
    'the store is made on the main thread; a worker reaches it over its channel'],
  [/^lib\/worker-message\.js$/, /^(\.\/logger|\.\/worker-output)$/, 'the main thread\'s end of a worker'],
  // dependencies: code that runs at the library's own load
  [/^node_modules\/stream-length\/node_modules\/bluebird\/js\/main\/promise\.js$/, /^\.\/(async|bind|captured_trace|catch_filter|context|debuggability|direct_resolve|errors|finally|join|method|progress|promise_array|promise_resolver|synchronous_inspection|thenables|util)\.js$/,
    'bluebird\'s setup function (the file\'s module.exports), called once by bluebird.js at its load'],
  [/^node_modules\/debug\/src\/node\.js$/, /^(fs|net)$/, 'createWritableStdioStream: at its load'],
  [/^node_modules\/socks-proxy-agent\/node_modules\/debug\/src\/common\.js$/, /^ms$/, 'setup(): at its load'],
  [/^node_modules\/tweetnacl\/nacl-fast\.js$/, /^crypto$/, 'an IIFE at its load'],
  [/^node_modules\/json-schema-ref-parser\/node_modules\/es6-promise\/dist\/es6-promise\.js$/, /^vertx$/,
    'attemptVertx (as r): only where Node\'s process.nextTick is missing; Node picks it at load'],
  // lazy-require's holder: the one load each lazy(name) makes, a finding of
  // its own above unless warmed at a worker's boot
  [/^lib\/lazy-require\.js$/, /^<dynamic>$/, 'the holder\'s first use: each lazy(name) is checked above (warmed, or reviewed)'],
  // set-options, before the lockdown: bcrypt-pbkdf along sshpk's chain
  [/^lib\/lean-worker\.js$/, /^(<dynamic>|http-signature|sshpk|bcrypt-pbkdf)$/, 'warmSshpkBcrypt: set-options, before the lockdown, with postman-request'],
  // dependencies: what a worker never reaches, or reaches harmlessly
  [/^node_modules\/uuid-1345\/index\.js$/, /^macaddress$/, 'v1 uuids only: a worker makes v5 (lib/call-address.js)'],
  [/^node_modules\/sshpk\/lib\/formats\/ssh-private\.js$/, /^bcrypt-pbkdf$/,
    'an encrypted OpenSSH key (httpSignature): bcrypt-pbkdf is warmed with postman-request at set-options (lib/lean-worker.js warmSshpkBcrypt), so this is a hit in Node\'s cache', FOLLOW],
  [/^node_modules\/@postman\/tough-cookie\/lib\/utilHelper\.js$/, /^util$/,
    'a module\'s own cookie jar (MemoryCookieStore): what it gets is only used to inspect that jar']
];

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
function parse(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
  for (const sourceType of ['script', 'module']) {
    try { return espree.parse(text, {ecmaVersion: 'latest', sourceType, range: true}); } catch (e) { /* the other */ }
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
        // at load, only a plain literal require is followed; the rest run
        // at load too, before any lockdown
        if (inFunction ? true : (kind === 'require' && request !== '<dynamic>')) out.push({request, inFunction, kind});
      }
    }
    if (callOf(node, 'lazy') && !WARMED.has(node.arguments[0].value)) {
      out.push({request: node.arguments[0].value, inFunction: true, kind: 'lazy'});
    }
    if (callOf(node, 'warm') && !topWarms.has(node)) {
      out.push({request: node.arguments[0].value, inFunction: true, kind: 'warm'});
    }
    if (node.type === 'ImportExpression') {
      out.push({request: literalOf(node.source), inFunction: true, kind: 'import'});
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
  it('every require or import inside a function there is reviewed, with why it never runs in a locked worker', () => {
    const seen = new Set();
    const queue = ENTRIES.slice();
    const unparsed = [];
    const findings = [];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file) || !file.endsWith('.js') && !file.endsWith('.cjs')) continue;
      seen.add(file);
      const ast = parse(file);
      if (ast == null) { unparsed.push(path.relative(ROOT, file)); continue; }
      for (const r of requiresOf(ast)) {
        if (Module.isBuiltin(r.request) && !r.inFunction) continue;
        if (r.inFunction) {
          const rel = path.relative(ROOT, file);
          const reviewed = REVIEWED.find(([f, q]) => f.test(rel) && q.test(r.request));
          if (reviewed == null) findings.push(`${rel}: ${r.kind}('${r.request}')`);
          // a reviewed load that can run in a worker (warmed, say) is
          // followed: what it loads is in the closure too
          if (reviewed == null || reviewed[3] !== FOLLOW || r.request === '<dynamic>' || Module.isBuiltin(r.request)) continue;
        }
        let target = null;
        try { target = require.resolve(r.request, {paths: [path.dirname(file)]}); } catch (e) { continue; }
        if (!Module.isBuiltin(target)) queue.push(target);
      }
    }
    assert.deepStrictEqual(unparsed, [], 'files the pin could not read');
    assert.deepStrictEqual(findings.sort(), [], `a require inside a function, not reviewed (${findings.length}):\n  ${findings.sort().join('\n  ')}`);
  });
});
