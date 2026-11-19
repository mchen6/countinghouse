// F4 (#194's PR 3): import() from an ES module, as module code makes it,
// of a runtime file against a missing one beside it, and of a package only
// the runtime has against a missing one: under enforce the whole error
// (code and message, each name masked) is the same, so whether it exists
// is no answer. root: the runtime's install, from the test's hand-over.
import {pathToFileURL} from 'url';
import path from 'path';

const tried = async (spec, name) => {
  try { await import(spec); return 'found'; } catch (e) { return `${e.code}|${e.message}`.split(name).join('NAME'); }
};
const same = (a, b) => (a === b ? 'same' : `differs(${a.slice(0, 160)} / ${b.slice(0, 160)})`);

export default async (root) => {
  const file = (name) => pathToFileURL(path.join(root, 'lib', name)).href;
  return [
    same(await tried(file('node-version.js'), 'node-version.js'), await tried(file('no-such-isolation.js'), 'no-such-isolation.js')),
    same(await tried(path.join(root, 'lib', 'node-version.js'), 'node-version.js'), await tried(path.join(root, 'lib', 'no-such-isolation.js'), 'no-such-isolation.js')),
    same(await tried('json-stringify-safe', 'json-stringify-safe'), await tried('no-such-isolation-pkg', 'no-such-isolation-pkg')),
    // (a file: URL spelled as Node's URL parser still takes it: upper case,
    // a leading space; the second round on #440)
    same(await tried(file('node-version.js').replace(/^file:/, 'FILE:'), 'node-version.js'), await tried(file('no-such-isolation.js').replace(/^file:/, 'FILE:'), 'no-such-isolation.js')),
    same(await tried(` ${file('node-version.js')}`, 'node-version.js'), await tried(` ${file('no-such-isolation.js')}`, 'no-such-isolation.js')),
    // (a '#' import whose bare target Node looks up above the root, PR 3)
    same(await tried('#p/json-stringify-safe', 'json-stringify-safe'), await tried('#p/no-such-isolation-pkg', 'no-such-isolation-pkg')),
    // (an own file named as Node reads a URL: a percent escape decoded, a
    // query kept, so two queries are two instances; the review of the
    // second round on #440)
    await own()
  ].join(' ');
};

const own = async () => {
  let escaped;
  try { escaped = (await import('./import%2Doracle.mjs')).default === undefined ? 'empty' : 'same'; } catch (e) { escaped = `escaped(${e.code})`; }
  const here = new URL(import.meta.url);
  const upper = (q) => `FILE:${here.href.slice('file:'.length)}?${q}`;
  let queried;
  try { queried = (await import(upper('a'))) !== (await import(upper('b'))) ? 'same' : 'one-instance'; } catch (e) { queried = `queried(${e.code})`; }
  // (by an absolute path too, which Node's ES resolver reads as a URL path)
  let absolute;
  try { absolute = (await import(`${here.pathname}?c`)) !== (await import(`${here.pathname}?d`)) ? 'same' : 'one-instance'; } catch (e) { absolute = `absolute(${e.code})`; }
  return `${escaped} ${queried} ${absolute}`;
};
