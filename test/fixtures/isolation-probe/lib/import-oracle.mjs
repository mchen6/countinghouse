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
    same(await tried('json-stringify-safe', 'json-stringify-safe'), await tried('no-such-isolation-pkg', 'no-such-isolation-pkg'))
  ].join(' ');
};
