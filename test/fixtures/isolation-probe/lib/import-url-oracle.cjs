// F4 from a CommonJS file (the medium review of PR 3): its import() of a
// file: URL outside the root, a runtime file against a missing one beside
// it, answers the same whole error (the name masked)
const {pathToFileURL} = require('url');
const path = require('path');

const tried = async (spec, name) => {
  try { await import(spec); return 'found'; } catch (e) { return `${e.code}|${e.message}`.split(name).join('NAME'); }
};

module.exports = async (root) => {
  const a = await tried(pathToFileURL(path.join(root, 'lib', 'node-version.js')).href, 'node-version.js');
  const b = await tried(pathToFileURL(path.join(root, 'lib', 'no-such-isolation.js')).href, 'no-such-isolation.js');
  return a === b ? 'same' : `differs(${a.slice(0, 160)} / ${b.slice(0, 160)})`;
};
