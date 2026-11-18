// exercise.js -- runs one path on which countinghouse's runtime used to
// load one of its own files after the worker's lockdown (#194's PR 1,
// test/sandbox/66). Each step only has to reach the path; what it returns
// doesn't matter.
const fs = require('fs');
// the CLI idiom (#425's review): a file the runtime loads must not read as a
// main module, or its entry-point code would run in the worker on every load
if (!module.parent) throw new Error('late-load-probe: loaded as a main module');

const STEPS = {
  // CHUtil.request: postman-request, loaded on its first use
  request: () => new Promise((resolve) => CHUtil.request({url: 'http://late-load.example.invalid/', timeout: 1000}, () => resolve())),
  // CHUtil.redis: redis-api, loaded on first use
  redis: () => new Promise((resolve) => {
    try { CHUtil.redis.get('late-load-probe', () => resolve()); } catch (e) { resolve(); }
  }),
  // getHostIp: bind-address
  hostIp: async () => CHUtil.getHostIp(),
  // loadFile: its first use
  loadFile: async () => CHUtil.loadFile(`${__dirname}/../../lib/parent-probe.js`),
  // FileHandle.readLines: the file broker's readline
  readLines: async () => {
    const h = await fs.promises.open(__filename);
    try { for await (const line of h.readLines()) { if (line != null) break; } } finally { await h.close(); }
  },
  // a bare name of a file in countinghouse's lib/: the lockdown's refusal
  // judges it (reachesLib), by names listed at boot, resolving nothing
  libName: async () => { try { require('cli-options'); } catch (e) { /* refused, or not found */ } },
  // CHUtil.request's options as the lockdown hands them on (#425's review):
  // httpSignature is an ordinary option (bcrypt-pbkdf, which sshpk loads on
  // an encrypted key, is preloaded with postman-request); an option on the
  // prototype is what audit reports, as postman-request would read it. Each
  // attempt's outcome: 'refused: <what>' (the sandbox's, naming what it
  // refused), or the request's own end.
  httpSignature: async () => {
    const base = () => ({url: 'http://late-load.example.invalid/', timeout: 1000});
    const forms = {
      signed: () => Object.assign(base(), {httpSignature: {keyId: 'k', key: 'not-a-key'}}),
      inheritedProxy: () => Object.assign(Object.create({proxy: 'http://late-load.example.invalid:1/'}), base())
    };
    const outcomes = {};
    for (const [name, make] of Object.entries(forms)) {
      outcomes[name] = await new Promise((resolve) => CHUtil.request(make(), (err) => resolve(
        err == null ? 'ok' : (/module sandbox/.test(String(err.message))
          ? `refused: ${(/network access to (\S+) is not allowed/.exec(String(err.message)) || [])[1]}`
          : `error: ${String(err.code || err.message).slice(0, 120)}`))));
    }
    return {outcomes};
  },
  // the runtime's loads of module files (this handler, by the dispatcher; a
  // file by CHUtil.loadFile): their parent is the module's own anchor, a
  // Module whose file is inside the module root (#425's review)
  parents: async () => ({handler: module.parent, loaded: CHUtil.loadFile(`${__dirname}/../../lib/parent-probe.js`).parent}),
  // module code's own createRequire and getBuiltinModule, through the
  // lockdown's wrappers: the module's, not the runtime's (the probe tells them
  // apart by the caller)
  ownLoaders: async () => {
    try { require('module').createRequire(__filename)('../../lib/parent-probe.js'); } catch (e) { /* refused or not: either way the module's */ }
    try { if (typeof(process.getBuiltinModule) === 'function') process.getBuiltinModule('path'); } catch (e) { /* the same */ }
  },
  // the probe's positive control: a load after the lockdown with one of the
  // runtime's Modules (reached through require.cache) as its parent, which
  // the probe must record (test/sandbox/66 asserts it does)
  control: async () => {
    const parent = Object.values(require.cache).find((m) => m != null && typeof(m.filename) === 'string' && /[\\/]lib[\\/]logger\.js$/.test(m.filename));
    if (parent == null) throw new Error('late-load-probe: no runtime Module in require.cache');
    const load = module.constructor._load;
    try { load('path', parent); } catch (e) { /* refused or not: the probe saw it first */ }
  },
  // an error the runtime logs and answers
  error: async () => { throw new Error('late-load-probe: an error to answer'); }
};

module.exports = async (input) => {
  const step = STEPS[input.step];
  if (step == null) return {output: {step: input.step, done: false}};
  const result = await step();
  if (input.step === 'parents') {
    const of = (m) => (m == null ? String(m) : String(m.filename));
    return {output: {step: input.step, done: true, handlerParent: of(result.handler), loadedParent: of(result.loaded)}};
  }
  if (input.step === 'httpSignature') return {output: {step: input.step, done: true, outcomes: JSON.stringify(result.outcomes)}};
  return {output: {step: input.step, done: true}};
};
