'use strict';
// The worker files a call's token or a peer port passes through, read as
// source: what module code could reach after it has loaded, because module
// code shares the worker's realm (the review of the worker hardening, rounds
// 1-3). It doesn't prove anything; it catches the next one of a class
// already found:
// - a require() in a function body (it returns whatever module code put in
//   require.cache by then), or require.cache read at all;
// - .bind(, .call( or .apply( looked up on a function at the time it runs
//   (a method module code replaced on Function.prototype is handed the
//   receiver), instead of one taken at load;
// - this.<x> = in a constructor (an assignment runs a setter module code put
//   on Object.prototype, with the new object as `this`);
// - for...of or spread over a value (an iterator module code replaced).
// Each reviewed exception is listed with its reason: code that runs at a
// worker's boot or set-options, before any module code; a main thread's
// branch (in worker mode no module code runs there); or the module's own
// values, which hold no runtime object.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib');
const FILES = ['lean-worker', 'peer-worker', 'peer-channel', 'port-scope', 'call-limits', 'hop-input', 'message-envelope', 'serialized-result',
  'query-device', 'service-client', 'handler-ctx', 'chutil-facade', 'countinghouse-util', 'worker-message'];

// [file, rule, the line's text (a regex), why]
const REVIEWED = [
  ['lean-worker', 'require in a function body', /^require\('\.\/fs-broker\/identity'\);$/, 'boot: before module code'],
  ['lean-worker', 'require in a function body', /^fsGrant = require\('\.\/fs-broker\/patch'\)/, 'boot: before module code'],
  ['lean-worker', 'for...of', /^for \(const name of PEER_METHODS\)/, 'boot: a literal list'],
  ['lean-worker', 'for...of', /^for \(const lib of \[callLimits/, 'boot: a literal list'],
  ['lean-worker', 'for...of', /^for \(const Ctor of \[WorkerMessage/, 'boot: a literal list'],
  ['lean-worker', 'require in a function body', /^require\('\.\/fs-broker\/patch'\)\.setConsoleSilenced/, 'set-options: before module code'],
  ['lean-worker', 'require in a function body', /^const lockdownLib = require\('\.\/module-lockdown'\);$/, 'set-options: before module code (loaded before the test probe\'s hand-over, #194\'s PR 2)'],
  ['lean-worker', 'require in a function body', /^redisAPI = require\('\.\/redis-api'\);$/, 'boot: in a try, so a load that throws is said on ctx.redis\'s first read (#194\'s PR 1)'],
  // the test-only late-load probe (sandbox 66): at boot, only with --testLateLoads
  ['lean-worker', 'require in a function body', /^const (Module|path) = require\('(module|path)'\);$/, 'the test\'s probe: at boot, only when the main thread asks'],
  ['lean-worker', 'for...of', /^for \(const \[key, what\] of \[\['_load', 'load'\]/, 'the test\'s probe: at boot, a literal list'],
  ['lean-worker', 'for...of', /^for \(const line of String\(new Error\(\)\.stack\)/, 'the test\'s probe: only when the main thread asks'],
  ['lean-worker', 'spread', /^return probeApply\(original, this, \[request, parent, \.\.\.rest\]\);$/, 'the test\'s probe: only when the main thread asks'],
  ['lean-worker', 'require in a function body', /^require\(bcryptFile\);$/, 'warmSshpkBcrypt: set-options, before module code (#425\'s review)'],
  // the test's probe hands its fixtures the runtime's modules, before the
  // lockdown, only with --testLateLoads (#194's PR 2, Revision 2's handle)
  ['lean-worker', 'require.cache', /^const (runtimeModule|lazy) = Module\._cache\[path\.join\(lib, '(logger|lazy-require)\.js'\)\];$/, 'the test\'s probe: before the lockdown, only with --testLateLoads'],
  ['lean-worker', 'require.cache', /^(files|modules): Object\.freeze\(Object\.(keys\(Module\._cache\)|assign\(Object\.create\(null\), Module\._cache\))\),$/, 'the test\'s probe: before the lockdown, only with --testLateLoads'],
  ['peer-worker', 'require in a function body', /require\('\.\/countinghouse-util'\)\.ci;$/, 'the main thread\'s and a test\'s: a lean worker\'s peer state always serves'],
  ['call-limits', 'require in a function body', /^c = require\('\.\/settings-tool'\)\.cachedCeiling/, 'main thread: a worker has outputCeiling, and returns before'],
  ['call-limits', 'require in a function body', /^const settings = require\('\.\/session-settings'\);$/, 'main thread: of() returns before in a worker'],
  ['call-limits', 'spread', /^\.\.\.\(limits\.bound === 'defaults' \? \{bound: 'defaults'\} : \{\}\)\}\);$/, 'an object literal spread: no iterator'],
  ['call-limits', 'spread', /^\.\.\.\(\(x\.bound === 'defaults' \|\| y\.bound === 'defaults'\)/, 'an object literal spread: no iterator'],
  ['message-envelope', 'for...of', /^for \(const key of Reflect\.ownKeys\(p\)\) \{$/, 'pinPort: at set-options and the bridge\'s boot, before module code'],
  ['message-envelope', 'a live bind, call or apply', /Object\.prototype\.hasOwnProperty\.call\(port, key\)\) continue;$/, 'pinPort: at set-options and the bridge\'s boot, before module code'],
  ['serialized-result', 'spread', /^const entries = \(v instanceof Map\)/, 'a refusal\'s pointer into the module\'s own output'],
  ['serialized-result', 'for...of', /^for \(const \[k, x\] of entries\) \{$/, 'a refusal\'s pointer into the module\'s own output'],
  ['query-device', 'require in a function body', /^if \(!workerAtLoad && threadInfo\.isMainThread === true\) return require\('\.\/countinghouse-device'\);$/, 'main thread: a worker never asks'],
  ['service-client', 'require in a function body', /^const userAuth  = require\('\.\/user-auth'\);$/, 'main thread: a worker\'s client is always a remote thread\'s'],
  ['handler-ctx', 'require in a function body', /^return require\('\.\/remote'\)\.callRemote\(/, 'main thread: a worker\'s remote call goes over its channel'],
  ['handler-ctx', 'require in a function body', /require\('\.\/usage\/query'\)\.answerUsageQuery/, 'main thread (isMainThread above)'],
  ['handler-ctx', 'require in a function body', /require\('\.\/module-ask'\)\.decide\(/, 'main thread (isMainThread above)'],
  ['handler-ctx', 'require in a function body', /require\('\.\/redis-api'\)\.namespacedClient\(/, 'main thread (isMainThread above)'],
  ['chutil-facade', 'for...of', /^for \(const name of METHODS\) \{$/, 'boot: createFacade, a literal list'],
  ['countinghouse-util', 'require in a function body', /^const facade = require\('\.\/single-thread-facade'\);$/, 'the module\'s own CHUtil.loadFile: its own file'],
  ['countinghouse-util', 'for...of', /^for \(const key of \['dm', 'ci'\]\) \{$/, 'load: a literal list'],
  // WorkerMessage: built at a worker's boot (its one), and on the main
  // thread (one per worker), where no module code runs in worker mode
  ['worker-message', 'an assignment in a constructor', /^this\.\w+\s*=/, 'constructor: built at boot in a worker, and on the main thread'],
  ['worker-message', 'a live bind, call or apply', /^if \(this\.worker != null\) this\.worker\.on\('message', this\.onEnvelope\.bind\(this\)\);$/, 'main thread (this.worker)'],
  ['worker-message', 'require in a function body', /require\('\.\/logger'\)\.E\(new Error\(`module worker /, 'main thread: a worker\'s end'],
  ['worker-message', 'require in a function body', /require\('\.\/worker-output'\)\./, 'main thread: a worker\'s messages'],
  ['worker-message', 'require in a function body', /^const callTokens = require\('\.\/call-tokens'\);$/, 'main thread: a device query\'s answer (isMainThread === true above)'],
  // the capture helpers and captures, defined at load (they are called there only)
  ['peer-worker', 'a live bind, call or apply', /^const uncurry = \(fn\) => Function\.prototype\.call\.bind\(fn\);$/, 'the capture helper: called at load'],
  ['peer-channel', 'a live bind, call or apply', /^const uncurry = \(fn\) => Function\.prototype\.call\.bind\(fn\);$/, 'the capture helper: called at load'],
  ['call-limits', 'a live bind, call or apply', /^const uncurry = \(fn\) => Function\.prototype\.call\.bind\(fn\);$/, 'the capture helper: called at load'],
  ['message-envelope', 'a live bind, call or apply', /^const uncurryE = \(fn\) => Function\.prototype\.call\.bind\(fn\);$/, 'the capture helper: called at load'],
  ['serialized-result', 'a live bind, call or apply', /^const uncurry = \(fn\) => Function\.prototype\.call\.bind\(fn\);$/, 'the capture helper: called at load'],
  ['handler-ctx', 'a live bind, call or apply', /^const uncurry = \(fn\) => Function\.prototype\.call\.bind\(fn\);$/, 'the capture helper: called at load'],
  ['message-envelope', 'a live bind, call or apply', /^const tagOf = Function\.prototype\.call\.bind\(/, 'a capture, at load'],
  ['message-envelope', 'a live array method', /^const CTORS = VIEWS\.map\(/, 'load: a literal list'],
  ['peer-channel', 'a collection built from an iterable', /^const NOT_SERVED = new Set\(\[/, 'load: a literal list'],
  ['worker-message', 'a collection built from an iterable', /^const RATE_(EXEMPT|QUIET) = new Set\(\[/, 'load: a literal list'],
  ['lean-worker', 'a live array method', /^Object\.keys\(console\)\.forEach\(/, 'set-options: before module code'],
  ['worker-message', 'a live array method', /^Object\.keys\(pending\)\.forEach\(/, 'main thread: a worker\'s end'],
  ['serialized-result', 'a live array method', /^const entries = \(v instanceof Map\)/, 'a refusal\'s pointer into the module\'s own output'],
  ['serialized-result', 'an assignment in a constructor', /^this\._(buffer|error) = /, 'SerializedResult: the main thread\'s'],
  ['serialized-result', 'an assignment in a constructor', /^this\.view = view;$/, 'NotJson: holds a view of the module\'s own output'],
  // reads of objects that are re-homed (lib/port-scope.js), or the runtime's
  // own null-prototype copies, or the module's own options to its own calls
  ['peer-worker', 'a read off a message or options not re-homed', /\bmsg\./, 'a message: re-homed by lean-worker\'s port handler before a peer method gets it'],
  ['peer-worker', 'a read off a message or options not re-homed', /\b(item\.)?args\./, 'a hop\'s args: the service client\'s own null-prototype copy'],
  ['hop-input', 'a read off a message or options not re-homed', /\bargs\./, 'a call\'s args: re-homed (lean-worker) or the service client\'s own copy'],
  ['service-client', 'a read off a message or options not re-homed', /\bopts\./, 'the options of the module\'s own invoke, or handler-ctx\'s null-prototype copy (billingWrapper)'],
  ['handler-ctx', 'a read off a message or options not re-homed', /\bargs\./, 'a call\'s args: re-homed (lean-worker), hop-input\'s or peer-worker\'s null-prototype copy'],
  ['handler-ctx', 'a read off a message or options not re-homed', /\bopts\./, 'the options of the module\'s own invoke or usage query'],
  ['countinghouse-util', 'a read off a message or options not re-homed', /\b(opts|args)\./, 'the module\'s own CHUtil options, or handler-ctx\'s null-prototype copy'],
  ['worker-message', 'a read off a message or options not re-homed', /\bmsg\./, 'main thread: a worker\'s messages (onWorkerMessage)'],
  ['worker-message', 'a read off a message or options not re-homed', /\bargs\.token\b/, 'a hop\'s args: the service client\'s own null-prototype copy'],
  ['peer-channel', 'a read off a message or options not re-homed', /\bmsg\./, 'a port message: re-homed by _onMessage, the only caller of the methods that read it'],
  ['peer-channel', 'a read off a message or options not re-homed', /hopInput\.encode\(\{input: input\}\)\.args\.inputBytes/, 'hop-input\'s own null-prototype copy'],
  ['port-scope', 'a read off a message or options not re-homed', /^for \(let i = 0; i < args\.length; i\+\+\) ObjectDefineProperty\(call/, 'a rest parameter: its own array'],
];

// the offending lines of src: [{line, rule, text}]
const CAPTURE = /^const \w+ += (uncurry\w*|Function\.prototype\.call\.bind|getter\w*)\((\w+\.)*\w+(\.prototype)?(\.\w+)?(, '\w+')?\);$/;
function offenders(src) {
  const lines = src.split('\n');
  const out = [];
  let inCtor = false;
  let classDepth = null;
  // the names re-homed so far in this top-level function (lib/port-scope.js
  // rehome, rehomeMessage): a read off one of them is a read of own data
  let rehomed = new Set();
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const line = lines[i].replace(/\s\/\/ .*$/, '');
    if (/^function [A-Z]\w*\(/.test(line)) inCtor = true;
    else if (/^\s*constructor\(/.test(line)) { inCtor = true; classDepth = line.match(/^\s*/)[0].length; }
    else if (classDepth != null && new RegExp(`^\\s{${classDepth}}}`).test(line)) { inCtor = false; classDepth = null; }
    else if (/^}/.test(line)) inCtor = false;
    const at = (rule) => out.push({line: i + 1, rule, text: line.trim()});
    if (/^(function |[\w.]+\s*=\s*function\b|async function )/.test(line)) rehomed = new Set();
    for (const m of line.matchAll(/\b(\w+)\s*=\s*rehome(Message)?\(/g)) rehomed.add(m[1]);
    const capture = CAPTURE.test(line.trim());
    if (/^\s+/.test(line) && /\brequire\(/.test(line)) at('require in a function body');
    if (/require\.cache|Module\._cache/.test(line)) at('require.cache');
    if (/\.(bind|call|apply)\(/.test(line) && !capture) at('a live bind, call or apply');
    if (inCtor && /\bthis\.\w+\s*=(?!=)/.test(line)) at('an assignment in a constructor');
    if (/for\s*\((const|let|var)\s+[^;]*\sof\s/.test(line)) at('for...of');
    for (const m of line.matchAll(/\.\.\.(\w|\[|\()/g)) {
      const before = line.slice(0, m.index);
      // a rest parameter: gathered, not iterated
      if (/(function\s*\w*\s*\(|\(\s*)[\w\s,]*$/.test(before) && /^\.\.\.\w+\)\s*(=>|\{)/.test(line.slice(m.index))) continue;
      at('spread');
    }
    if (/\.(push|shift|unshift|splice|forEach|map|filter|some|every|find|indexOf|includes)\(/.test(line) && !capture) at('a live array method');
    if (/new (Set|Map|WeakMap|WeakSet)\(\s*[^)\s]/.test(line)) at('a collection built from an iterable');
    for (const m of line.matchAll(/\b(msg|args|opts)\.\w+/g)) {
      if (!rehomed.has(m[1]) && !/\b(\w+)\s*=\s*rehome(Message)?\(/.test(line)) { at('a read off a message or options not re-homed'); break; }
    }
  }
  return out;
}

describe('sandbox 64: the worker\'s token path, read as source', () => {
  it('the guard sees the forms it is for, and passes what it should', () => {
    const rules = (src) => offenders(src).map((o) => o.rule);
    assert.deepStrictEqual(rules('function f() {\n  return require(\'./x\');\n}'), ['require in a function body']);
    assert.deepStrictEqual(rules('const x = require(\'./x\');'), []);
    assert.deepStrictEqual(rules('const m = require.cache[k];'), ['require.cache']);
    assert.deepStrictEqual(rules('  onPortMessage(port, this.f.bind(this));'), ['a live bind, call or apply']);
    assert.deepStrictEqual(rules('const MapGet = uncurry(Map.prototype.get);'), []);
    assert.deepStrictEqual(rules('const Bind = Function.prototype.call.bind(Function.prototype.bind);'), []);
    assert.deepStrictEqual(rules('function Thing(a) {\n  this.a = a;\n  setOwn(this, \'b\', 1);\n}\nThing.prototype.x = function() { this.c = 1; };'), ['an assignment in a constructor']);
    assert.deepStrictEqual(rules('  for (const x of list) f(x);'), ['for...of']);
    assert.deepStrictEqual(rules('  g(...list);'), ['spread']);
    assert.deepStrictEqual(rules('  const f = function(...args) { return 1; };\n  const g = (...a) => a;'), []);
    assert.deepStrictEqual(rules('class C {\n  constructor(a) {\n    this.a = a;\n  }\n  m() { this.b = 1; }\n}'), ['an assignment in a constructor']);
    assert.deepStrictEqual(rules('  queue.push(item);'), ['a live array method']);
    assert.deepStrictEqual(rules('  const s = new Set(list);\n  const t = new Set();'), ['a collection built from an iterable']);
    assert.deepStrictEqual(rules('  const id = msg.id;'), ['a read off a message or options not re-homed']);
    assert.deepStrictEqual(rules('const {rehome} = require(\'./port-scope\');\nfunction f(m) {\n  const msg = rehome(m);\n  return msg.id;\n}'), []);
    assert.deepStrictEqual(rules('const {rehome} = require(\'./port-scope\');\nfunction f(m) {\n  const msg = rehome(m);\n  return msg.id;\n}\nfunction g(opts) {\n  return opts.x;\n}'),
      ['a read off a message or options not re-homed'], 'a re-homing file still flags a read nothing re-homed');
    assert.deepStrictEqual(rules('const x = uncurry(Map.prototype.get);\nconst y = uncurry(Map.prototype.get); f.call(this);'), ['a live bind, call or apply']);
  });

  for (const name of FILES) {
    it(`lib/${name}.js: nothing module code could hand itself, but what is reviewed`, () => {
      const found = offenders(fs.readFileSync(path.join(LIB, `${name}.js`), 'utf8'));
      const left = found.filter((o) => !REVIEWED.some(([file, rule, re]) => file === name && rule === o.rule && re.test(o.text)));
      assert.deepStrictEqual(left.map((o) => `${o.line} ${o.rule}: ${o.text}`), []);
    });
  }

  // (#493's high: Error.captureStackTrace and Error.prepareStackTrace read
  // by their live global names in a runtime file hand module code that
  // replaced them the runtime's own errors: each is taken at load. Every
  // lib file, read as source; the reviewed sites each say why)
  it('no runtime file calls Error.captureStackTrace or sets Error.prepareStackTrace by its live name, but the reviewed', () => {
    const REVIEWED_LIVE = [
      ['single-thread-facade.js', /Error\.(captureStackTrace|prepareStackTrace)/, 'the main thread\'s, in single-thread mode only: no worker'],
      ['lean-worker.js', /Error\.prepareStackTrace/, 'the test\'s late-load probe: never in a normal start']
    ];
    const found = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith('//') || t.startsWith('*')) return;
            if (!/\bError\.captureStackTrace\(|\bError\.prepareStackTrace\s*=[^=]/.test(t)) return;
            const rel = path.relative(LIB, p);
            if (REVIEWED_LIVE.some(([f, re]) => rel === f && re.test(t))) return;
            found.push(`${rel}:${i + 1}: ${t}`);
          });
        }
      }
    };
    walk(LIB);
    assert.deepStrictEqual(found, []);
  });

  it('every reviewed exception still matches a line (none is stale)', () => {
    const stale = REVIEWED.filter(([file, rule, re]) => !offenders(fs.readFileSync(path.join(LIB, `${file}.js`), 'utf8')).some((o) => o.rule === rule && re.test(o.text)));
    assert.deepStrictEqual(stale.map(([file, rule, re, why]) => `${file} ${rule} ${re} (${why})`), []);
  });
});
