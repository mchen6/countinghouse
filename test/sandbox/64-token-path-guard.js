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

// [file, the line's text (a regex), why]
const REVIEWED = [
  ['lean-worker', /^require\('\.\/fs-broker\/identity'\);$/, 'boot: before module code'],
  ['lean-worker', /^fsGrant = require\('\.\/fs-broker\/patch'\)/, 'boot: before module code'],
  ['lean-worker', /^for \(const name of PEER_METHODS\)/, 'boot: a literal list'],
  ['lean-worker', /^for \(const lib of \[callLimits/, 'boot: a literal list'],
  ['lean-worker', /^for \(const Ctor of \[WorkerMessage/, 'boot: a literal list'],
  ['lean-worker', /^const redisAPI = require\('\.\/redis-api'\);$/, 'first use: handed only its own Redis send (redisSender)'],
  ['lean-worker', /^require\('\.\/fs-broker\/patch'\)\.setConsoleSilenced/, 'set-options: before module code'],
  ['lean-worker', /^require\('\.\/fs-broker\/identity'\)\.install\(/, 'set-options: before module code'],
  ['lean-worker', /^lockdown = require\('\.\/module-lockdown'\)\.install\(/, 'set-options: before module code'],
  ['lean-worker', /^require\('\.\/settings-tool'\)\.applyLiveOptions/, 'live options: the worker\'s own copy of the options, no token (#194 P)'],
  ['lean-worker', /^require\('\.\/module-validator'\)\.validateModule/, 'a validation worker, discarded after (#194 P)'],
  ['peer-worker', /require\('\.\/countinghouse-util'\)\.ci;$/, 'the main thread\'s and a test\'s: a lean worker\'s peer state always serves'],
  ['call-limits', /^c = require\('\.\/settings-tool'\)\.cachedCeiling/, 'main thread: a worker has outputCeiling, and returns before'],
  ['call-limits', /^const settings = require\('\.\/session-settings'\);$/, 'main thread: of() returns before in a worker'],
  ['call-limits', /^\.\.\.\(limits\.bound === 'defaults' \? \{bound: 'defaults'\} : \{\}\)\}\);$/, 'an object literal spread: no iterator'],
  ['call-limits', /^\.\.\.\(\(x\.bound === 'defaults' \|\| y\.bound === 'defaults'\)/, 'an object literal spread: no iterator'],
  ['message-envelope', /^for \(const key of Reflect\.ownKeys\(p\)\) \{$/, 'pinPort: at set-options and the bridge\'s boot, before module code'],
  ['message-envelope', /Object\.prototype\.hasOwnProperty\.call\(port, key\)\) continue;$/, 'pinPort: at set-options and the bridge\'s boot, before module code'],
  ['serialized-result', /^const entries = \(v instanceof Map\)/, 'a refusal\'s pointer into the module\'s own output'],
  ['serialized-result', /^for \(const \[k, x\] of entries\) \{$/, 'a refusal\'s pointer into the module\'s own output'],
  ['query-device', /^if \(!workerAtLoad && threadInfo\.isMainThread === true\) return require\('\.\/countinghouse-device'\);$/, 'main thread: a worker never asks'],
  ['service-client', /^const userAuth  = require\('\.\/user-auth'\);$/, 'main thread: a worker\'s client is always a remote thread\'s'],
  ['handler-ctx', /^return require\('\.\/remote'\)\.callRemote\(/, 'main thread: a worker\'s remote call goes over its channel'],
  ['handler-ctx', /require\('\.\/usage\/query'\)\.answerUsageQuery/, 'main thread (isMainThread above)'],
  ['handler-ctx', /require\('\.\/module-ask'\)\.decide\(/, 'main thread (isMainThread above)'],
  ['handler-ctx', /require\('\.\/redis-api'\)\.namespacedClient\(/, 'main thread (isMainThread above)'],
  ['chutil-facade', /^for \(const name of METHODS\) \{$/, 'boot: createFacade, a literal list'],
  ['countinghouse-util', /^return require\('\.\/bind-address'\)\.hostIp\(\);$/, 'the module\'s own CHUtil.getHostIp: no token'],
  ['countinghouse-util', /^let p = require\('\.\/fs-broker\/identity'\)\.resolveModulePath\(name\);$/, 'the module\'s own CHUtil.loadFile: its own file'],
  ['countinghouse-util', /^const facade = require\('\.\/single-thread-facade'\);$/, 'the module\'s own CHUtil.loadFile: its own file'],
  ['countinghouse-util', /^return require\(require\('\.\/fs-broker\/identity'\)\.specifierFor\(p\)\);$/, 'the module\'s own CHUtil.loadFile: its own file'],
  ['countinghouse-util', /^for \(const key of \['dm', 'ci'\]\) \{$/, 'load: a literal list'],
  // WorkerMessage: built at a worker's boot (its one), and on the main
  // thread (one per worker), where no module code runs in worker mode
  ['worker-message', /^this\.\w+\s*=/, 'constructor: built at boot in a worker, and on the main thread'],
  ['worker-message', /^if \(this\.worker != null\) this\.worker\.on\('message', this\.onEnvelope\.bind\(this\)\);$/, 'main thread (this.worker)'],
  ['worker-message', /require\('\.\/logger'\)\.E\(new Error\(`module worker /, 'main thread: a worker\'s end'],
  ['worker-message', /require\('\.\/worker-output'\)\./, 'main thread: a worker\'s messages']
];

// the offending lines of src: [{line, rule, text}]
function offenders(src) {
  const lines = src.split('\n');
  const out = [];
  let inCtor = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    const line = lines[i].replace(/\s\/\/ .*$/, '');
    if (/^function [A-Z]\w*\(/.test(line)) inCtor = true;
    else if (/^}/.test(line)) inCtor = false;
    const at = (rule) => out.push({line: i + 1, rule, text: line.trim()});
    if (/^\s+/.test(line) && /\brequire\(/.test(line)) at('require in a function body');
    if (/require\.cache|Module\._cache/.test(line)) at('require.cache');
    if (/\.(bind|call|apply)\(/.test(line) && !/^const \w+ += .*(Function\.prototype\.call\.bind|call\.bind)\(/.test(line) && !/\buncurry\w*\(/.test(line)) at('a live bind, call or apply');
    if (inCtor && /\bthis\.\w+\s*=(?!=)/.test(line)) at('an assignment in a constructor');
    if (/for\s*\((const|let|var)\s+[^;]*\sof\s/.test(line)) at('for...of');
    for (const m of line.matchAll(/\.\.\.(\w|\[|\()/g)) {
      const before = line.slice(0, m.index);
      // a rest parameter: gathered, not iterated
      if (/(function\s*\w*\s*\(|\(\s*)[\w\s,]*$/.test(before) && /^\.\.\.\w+\)\s*(=>|\{)/.test(line.slice(m.index))) continue;
      at('spread');
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
  });

  for (const name of FILES) {
    it(`lib/${name}.js: nothing module code could hand itself, but what is reviewed`, () => {
      const found = offenders(fs.readFileSync(path.join(LIB, `${name}.js`), 'utf8'));
      const left = found.filter((o) => !REVIEWED.some(([file, re]) => file === name && re.test(o.text)));
      assert.deepStrictEqual(left.map((o) => `${o.line} ${o.rule}: ${o.text}`), []);
    });
  }

  it('every reviewed exception still matches a line (none is stale)', () => {
    const stale = REVIEWED.filter(([file, re]) => !offenders(fs.readFileSync(path.join(LIB, `${file}.js`), 'utf8')).some((o) => re.test(o.text)));
    assert.deepStrictEqual(stale.map(([file, re, why]) => `${file} ${re} (${why})`), []);
  });
});
