// exercise.js -- runs one path on which countinghouse's runtime used to
// load one of its own files after the worker's lockdown (#194's PR 1,
// test/sandbox/66). Each step returns what it reached (detail), so a step
// that never reaches its path fails the test, not just one that loads late.
const fs = require('fs');
// the CLI idiom (#425's review): a file the runtime loads must not read as a
// main module, or its entry-point code would run in the worker on every load
if (!module.parent) throw new Error('late-load-probe: loaded as a main module');

const URL_DECLARED = 'http://late-load.example.invalid/';
// an error's code, or what the sandbox refused
const ended = (err) => (err == null ? 'ok' : (/module sandbox/.test(String(err.message))
  ? `refused: ${(/network access to (\S+) is not allowed/.exec(String(err.message)) || [])[1]}`
  : `error: ${String(err.code || err.message).slice(0, 120)}`));
// a runtime Module, and a runtime function that calls what it is handed
// (lib/lazy-require.js orCallback: the caller of a hook the probe tells
// apart by its stack): module code reaches neither since #194's PR 2, so
// the test's probe hands them over (lib/lean-worker.js, a test-only global
// it defines only when the probe is on)
const handle = () => globalThis[Symbol.for('countinghouse.test.runtime')] || null;
const runtimeModule = () => (handle() != null ? handle().module : null);
const runtimeCaller = () => (handle() != null ? handle().caller : null);

const STEPS = {
  // CHUtil.request to a declared host: postman-request (preloaded with net)
  request: () => new Promise((resolve) => CHUtil.request({url: URL_DECLARED, timeout: 1000}, (err) => resolve(ended(err)))),
  // CHUtil.redis: redis-api's client, made at boot
  redis: () => new Promise((resolve) => {
    try { CHUtil.redis.get('late-load-probe', (err) => resolve(`called: ${ended(err)}`)); } catch (e) { resolve(`threw: ${e.message}`); }
  }),
  // getHostIp: bind-address
  hostIp: async () => typeof(CHUtil.getHostIp()),
  // loadFile: the module's own file, by the runtime
  loadFile: async () => (CHUtil.loadFile(`${__dirname}/../../lib/parent-probe.js`).parent != null ? 'loaded' : 'no parent'),
  // loadFile of countinghouse's own files (#425's final review): a lib/ file
  // and one of its node_modules, named by their host paths as module code
  // can find them (require.cache): refused, never loaded as the runtime's
  // with its exports handed back
  loadRuntime: async () => {
    const logger = runtimeModule();
    if (logger == null) return 'no runtime path';
    const lib = logger.filename.replace(/[\\/]logger\.js$/, '');
    const sep = logger.filename.includes('\\') ? '\\' : '/';
    const attempt = (p) => { try { CHUtil.loadFile(p); return 'loaded'; } catch (e) { return String(e.code); } };
    return [attempt(`${lib}${sep}settings-tool.js`), attempt(`${lib}${sep}..${sep}node_modules${sep}json-stringify-safe${sep}stringify.js`)].join(' ');
  },
  // FileHandle.readLines: the file broker's readline
  // (read to the end: leaving the loop early, then closing the handle while
  // a read is in flight, is a broker case of its own, followed up apart)
  readLines: async () => {
    const h = await fs.promises.open(__filename);
    let n = 0;
    try { for await (const line of h.readLines()) { if (line != null) n += 1; } } finally { await h.close(); }
    return n > 0 ? 'read' : 'empty';
  },
  // a bare name of a file in countinghouse's lib/: the lockdown's refusal
  // judges it (reachesLib), by names listed at boot, resolving nothing
  libName: async () => { try { require('cli-options'); return 'loaded'; } catch (e) { return String(e.code); } },
  // module code's own createRequire and getBuiltinModule, through the
  // lockdown's wrappers: the module's, not the runtime's
  ownLoaders: async () => {
    let a = 'none';
    try { require('module').createRequire(__filename)('../../lib/parent-probe.js'); a = 'createRequire'; } catch (e) { a = `createRequire: ${e.code}`; }
    if (typeof(process.getBuiltinModule) === 'function') process.getBuiltinModule('path');
    return a;
  },
  // a worker log line (CHUtil.recordUsage logs through the worker's logger)
  log: () => new Promise((resolve) => CHUtil.recordUsage('late-load-probe', 'probe', 0, (err, r) => resolve(err == null && r != null ? 'logged' : ended(err)))),
  // the call's progress, its usage, a question, and a hop
  progress: async (ctx) => { ctx.job.progress(50); return 'reported'; },
  usage: async (ctx) => { const u = await ctx.usage(); return u != null ? 'read' : 'none'; },
  ask: async (ctx) => { try { await ctx.ask('late-load-probe', {}); return 'answered'; } catch (e) { return String(e.code); } },
  call: async (ctx) => { try { await ctx.call('late-load-probe/probeService.exercise', {step: 'hostIp'}); return 'called'; } catch (e) { return String(e.code); } },
  // an output past --maxOutputBytes: OUTPUT_TOO_LARGE, decided in this worker
  tooLarge: async () => 'x'.repeat(300000),
  // path's functions replaced by module code (#425's review): the lockdown
  // fixes path in both modes, so the replacement doesn't stick (said), and
  // a module specifier that walks out of the root is still refused
  pathSwap: async () => {
    const posix = require('path').posix;
    const was = {join: posix.join, resolve: posix.resolve};
    try {
      try { posix.join = (...a) => a.join('/'); posix.resolve = (...a) => a[a.length - 1]; } catch (e) { /* locked */ }
      const replaced = posix.join('a', '..') === 'a/..' ? 'replaced' : 'not replaced';
      // three levels up from this module's root is the repository's: kept
      // inside the root, the name is lib/cli-options.js there, which this
      // module has none of; let out, it is countinghouse's own file
      try {
        require('countinghouse-module:/../../../lib/cli-options.js');
        return `${replaced}: loaded`;
      } catch (e) {
        return `${replaced}: ${e.code}`;
      }
    } finally {
      try { posix.join = was.join; posix.resolve = was.resolve; } catch (e) { /* locked */ }
    }
  },
  // CHUtil.request's options as the lockdown hands them on (#425's review):
  // httpSignature is an ordinary option (bcrypt-pbkdf, which sshpk loads on
  // an encrypted key, is preloaded with postman-request); an option on the
  // prototype is what audit reports, as postman-request would read it; and
  // a second options argument is checked as the first is
  httpSignature: async () => {
    const base = () => ({url: URL_DECLARED, timeout: 1000});
    const forms = {
      signed: (cb) => CHUtil.request(Object.assign(base(), {httpSignature: {keyId: 'k', key: 'not-a-key'}}), cb),
      inheritedProxy: (cb) => CHUtil.request(Object.assign(Object.create({proxy: 'http://late-load.example.invalid:1/'}), base()), cb),
      secondArgument: (cb) => CHUtil.request('http://elsewhere.example.invalid/', {timeout: 1000}, cb),
      // the callback as an option: answered, refused or not
      callbackOption: (cb) => CHUtil.request({url: 'http://elsewhere.example.invalid/', timeout: 1000, callback: cb})
    };
    const outcomes = {};
    // (a request may throw as it is made: http-signature on this key)
    for (const [name, make] of Object.entries(forms)) {
      outcomes[name] = await new Promise((resolve) => {
        try { make((err) => resolve(ended(err))); } catch (e) { resolve(`threw: ${String(e.message).slice(0, 120)}`); }
      });
    }
    return {outcomes};
  },
  // the runtime's loads of module files (this handler, by the dispatcher; a
  // file by CHUtil.loadFile): their parent is the module's own anchor, a
  // Module whose file is inside the module root (#425's review)
  // module code that rewrites the anchor it holds shapes no later load (a
  // fresh anchor each time)
  parents: async () => {
    const handler = String(module.parent.filename);
    module.parent.filename = '/tampered.js';
    module.parent.children = new Proxy([], {});
    delete require.cache[require.resolve('../../lib/parent-probe.js')];
    return {handler: {filename: handler}, loaded: CHUtil.loadFile(`${__dirname}/../../lib/parent-probe.js`).parent};
  },
  // the probe's positive control: each of the four hooks with a runtime
  // parent or caller after the lockdown, which the probe must record
  control: async () => {
    const parent = runtimeModule();
    if (parent == null) return 'no runtime Module';
    const M = module.constructor;
    try { M._load('path', parent); } catch (e) { /* recorded first */ }
    try { M._resolveFilename('path', parent); } catch (e) { /* recorded first */ }
    const call = runtimeCaller();
    if (call == null) throw new Error('late-load-probe: no runtime caller in require.cache');
    try { call(M.createRequire); } catch (e) { /* recorded first */ }
    if (typeof(process.getBuiltinModule) === 'function') { try { call(process.getBuiltinModule); } catch (e) { /* recorded first */ } }
    return 'ran';
  },
  // sshpk's lazy require of bcrypt-pbkdf (warmed with postman-request, #425):
  // after the seal (#194's PR 2) the net answers that one require, by
  // sshpk's own Module, from what it was at the lockdown (another load from
  // a runtime Module, refused: test/sandbox/68)
  lazyHit: async () => {
    const h = handle();
    if (h == null || h.modules == null) return 'no handle';
    const key = Object.keys(h.modules).find((k) => /[\\/]node_modules[\\/]sshpk[\\/]lib[\\/]formats[\\/]ssh-private\.js$/.test(k));
    if (key == null) return 'no sshpk';
    const M = module.constructor;
    let served;
    try { served = typeof(M._load('bcrypt-pbkdf', h.modules[key]).pbkdf) === 'function' ? 'served' : 'other'; } catch (e) { served = String(e.code); }
    return served;
  },
  // an error the runtime logs and answers
  error: async () => { throw new Error('late-load-probe: an error to answer'); }
};

module.exports = async (input, ctx) => {
  const step = STEPS[input.step];
  if (step == null) return {output: {step: input.step, done: false}};
  const result = await step(ctx);
  if (input.step === 'parents') {
    const of = (m) => (m == null ? String(m) : String(m.filename));
    return {output: {step: input.step, done: true, handlerParent: of(result.handler), loadedParent: of(result.loaded)}};
  }
  if (input.step === 'httpSignature') return {output: {step: input.step, done: true, outcomes: JSON.stringify(result.outcomes)}};
  return {output: {step: input.step, done: true, detail: String(result)}};
};
