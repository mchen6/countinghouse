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
const REVIEWED = [
  // set-options and boot, before the lockdown
  [/^lib\/lean-worker\.js$/, /^\.\/fs-broker\/(identity|patch)$/, 'boot and set-options: before the lockdown'],
  [/^lib\/lean-worker\.js$/, /^\.\/module-lockdown$/, 'set-options: the lockdown itself'],
  [/^lib\/fs-broker\/identity\.js$/, /^(fs|\.\/roots)$/, 'the main thread\'s code roots, and insideHostFor at load'],
  [/^lib\/fs-broker\/identity\.js$/, /^os$/, 'install: at set-options, before the lockdown'],
  [/^lib\/fs-broker\/patch\.js$/, /^\.\/roots$/, 'install: at boot'],
  [/^lib\/lean-worker\.js$/, /^postman-request$/, 'warm, at set-options before the lockdown, for a module that declares net'],
  [/^lib\/lean-worker\.js$/, /^\.\/declarations$/, 'warm, at boot in a validation worker (validateOnly)'],
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
  [/^lib\/store\.js$/, /./, 'the store is made on the main thread; a worker reaches it over its channel'],
  [/^lib\/worker-message\.js$/, /^(\.\/logger|\.\/worker-output)$/, 'the main thread\'s end of a worker'],
  // dependencies: code that runs at the library's own load
  [/^node_modules\/stream-length\/node_modules\/bluebird\/js\/main\/promise\.js$/, /./, 'bluebird\'s setup function, run once at its load'],
  [/^node_modules\/debug\/src\/node\.js$/, /^(fs|net)$/, 'createWritableStdioStream: at its load'],
  [/^node_modules\/socks-proxy-agent\/node_modules\/debug\/src\/common\.js$/, /^ms$/, 'setup(): at its load'],
  [/^node_modules\/tweetnacl\/nacl-fast\.js$/, /^crypto$/, 'an IIFE at its load'],
  // dependencies: what a worker never reaches, or reaches harmlessly
  [/^node_modules\/uuid-1345\/index\.js$/, /^macaddress$/, 'v1 uuids only: a worker makes v5 (lib/call-address.js)'],
  [/^node_modules\/sshpk\/lib\/formats\/ssh-private\.js$/, /^bcrypt-pbkdf$/, 'an encrypted OpenSSH key, reached only through the httpSignature request option, refused (lib/module-lockdown.js)'],
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
// every require('x') / import('x') with a literal, and whether it sits in a
// function; and every lazy('x') (lib/lazy-require.js), a load on first use
// unless warmed
function requiresOf(ast) {
  const out = [];
  const topWarms = topLevelWarms(ast);
  const visit = (node, inFunction) => {
    if (node == null || typeof(node.type) !== 'string') return;
    const here = inFunction || FUNCTIONS.has(node.type);
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
        node.arguments.length === 1 && node.arguments[0].type === 'Literal' && typeof(node.arguments[0].value) === 'string') {
      out.push({request: node.arguments[0].value, inFunction});
    }
    if (callOf(node, 'lazy') && !WARMED.has(node.arguments[0].value)) {
      out.push({request: node.arguments[0].value, inFunction: true, kind: 'lazy'});
    }
    if (callOf(node, 'warm') && !topWarms.has(node)) {
      out.push({request: node.arguments[0].value, inFunction: true, kind: 'warm'});
    }
    if (node.type === 'ImportExpression' && node.source.type === 'Literal' && typeof(node.source.value) === 'string') {
      out.push({request: node.source.value, inFunction});
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
          if (!REVIEWED.some(([f, q]) => f.test(rel) && q.test(r.request))) findings.push(`${rel}: ${r.kind || 'require'}('${r.request}')`);
          continue;
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
