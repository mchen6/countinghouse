'use strict';
// A user's own module, as the single-identity profile's authoring tools see
// it (B-own-runtime; the own-modules design, tech/plans/2026-11-20-own-
// modules-design.md §2.1 and §2.3). The same rules ch-local's add-module
// applies before the user's yes, checked here without running the module's
// code:
//   - pathRefusal: the folder's kernel real path must not be inside the
//     ch-local home (the settings file's folder), --modulePath,
//     --moduleDataPath or the store, and no part of the path on the way may
//     be a link -- so validation never reads the runtime's or ch-local's own
//     trees (credentials among them);
//   - treeProblems: no npm dependencies of any kind and no node_modules (an
//     own module's code is all its own, hashed and confirmed), no link
//     inside, at most MAX_ENTRIES entries and MAX_TREE_BYTES in all.
// Answers name files and fields, never a file's content.
const fs = require('fs');
const path = require('path');

// the fields ch-local's unpack refuses for a pack (lib/unpack.js there)
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
// the in-place load's walk bound (lib/modules-in-place.js closurePlan)
const MAX_ENTRIES = 20000;
// small: no dependencies, and the tree is hashed at every start (the
// reviewer, 2026-11-20); raised later if a real module needs more
const MAX_TREE_BYTES = 16 * 1024 * 1024;

const isWin = () => process.platform === 'win32';
const norm = (p) => (isWin() ? p.toLowerCase() : p);
// whether p is root or inside it (both real paths): a name that merely
// starts with '..' (<root>/..mine) is inside
function inside(p, root) {
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
const realOrNull = (p) => { try { return fs.realpathSync.native(p); } catch (e) { return null; } };

// input: the path the caller named; roots: {home, modulePath,
// moduleDataPath, storePath} (any may be null) -> {real} (the folder's
// kernel real path, which every later read uses), or {message}, a refusal
// naming what is wrong (never the folder's content). Neither inside a root
// nor holding one (a parent of the home walks it).
function pathRefusal(input, roots) {
  if (typeof(input) !== 'string' || input === '' || input.length > 4096 || input.includes('\0') || !path.isAbsolute(input)) {
    return {message: 'the path is not an absolute path to a folder'};
  }
  // no link on the way: every part of the path as written, from the root
  const resolved = path.resolve(input);
  const parts = resolved.split(path.sep).filter((s) => s !== '');
  let at = path.parse(resolved).root;
  for (const part of parts) {
    at = path.join(at, part);
    let st;
    try { st = fs.lstatSync(at); } catch (e) { return {message: 'the folder is not there'}; }
    if (st.isSymbolicLink()) return {message: 'the path goes through a link: name the folder by its real path'};
  }
  let st;
  try { st = fs.statSync(resolved); } catch (e) { return {message: 'the folder is not there'}; }
  if (!st.isDirectory()) return {message: 'the path is not a folder'};
  const real = realOrNull(resolved);
  if (real == null) return {message: 'the folder is not there'};
  for (const [what, root] of [['the ch-local home', roots.home], ['the runtime\'s modules folder', roots.modulePath],
    ['the runtime\'s module data folder', roots.moduleDataPath], ['the runtime\'s store', roots.storePath]]) {
    if (root == null) continue;
    const r = realOrNull(root);
    if (r == null) continue;
    if (inside(real, r)) return {message: `the folder is inside ${what}: keep your own module's folder elsewhere`};
    if (inside(r, real)) return {message: `the folder holds ${what}: name your module's own folder`};
  }
  return {real};
}

// A message as the profile answers it: whatever follows "cannot be parsed"
// or "cannot be read" (an error's own text, which can quote the file) cut
// off -- never a guess at the parser's wording (the reviewer's high on
// #499, 3); the static validation asks for no such text in the first place
// (module-tree-check's plain option)
function scrub(message) {
  const m = /\bcannot be (parsed|read)\b/.exec(String(message));
  return m == null ? String(message) : `${String(message).slice(0, m.index)}cannot be ${m[1]}`;
}

// What package.json says, once read plainly (pkg, or null) -> [message]
function pkgProblems(pkg) {
  const problems = [];
  // (an own module is a scenario: the single-identity profile lists only
  // scenarios' tools, lib/mcp/tool-registry.js listingOf)
  const ch = (pkg != null && typeof(pkg) === 'object' && pkg.countinghouse != null && typeof(pkg.countinghouse) === 'object') ? pkg.countinghouse : null;
  if (ch == null || ch.role !== 'scenario') {
    problems.push('an own module is a scenario: set "countinghouse": {"role": "scenario"} in its package.json, or its tools are never listed');
  }
  if (pkg != null && typeof(pkg) === 'object') {
    const declared = DEPENDENCY_FIELDS.filter((f) => pkg[f] != null && (Array.isArray(pkg[f]) ? pkg[f].length > 0 : (typeof(pkg[f]) === 'object' && Object.keys(pkg[f]).length > 0)));
    if (declared.length > 0) {
      problems.push(`package.json declares npm dependencies (${declared.join(', ')}): an own module has none in this release; copy the code it needs into its folder`);
    }
  }
  return problems;
}

// The module folder (its real path), walked by lstat alone -- no file in it
// read -> {problems: [message], blocking}: blocking when the folder must not
// be read at all (a link, a second name, anything but a file or a folder --
// a FIFO, a socket, a device -- inside, too many entries or bytes):
// validation stops there, before any file is read (the reviewer's high on
// #499, 1 and 2)
function treeProblems(dir) {
  const problems = [];
  let entries = 0;
  let bytes = 0;
  const links = [];
  const twice = [];
  const special = [];
  let nodeModules = false;
  let over = false;
  const walk = (at, rel) => {
    if (over) return;
    let names;
    try { names = fs.readdirSync(at); } catch (e) { problems.push(`${rel || '.'} cannot be read (${e.code || 'error'})`); return; }
    for (const name of names) {
      if (over) return;
      entries++;
      if (entries > MAX_ENTRIES) { over = true; return; }
      const child = path.join(at, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      let st;
      try { st = fs.lstatSync(child); } catch (e) { continue; }
      if (st.isSymbolicLink()) { links.push(childRel); continue; }
      if (st.isDirectory()) {
        if (name === 'node_modules') nodeModules = true;
        walk(child, childRel);
      } else if (st.isFile()) {
        bytes += st.size;
        // (a file under a second name -- a hard link -- may be another's)
        if (st.nlink > 1) twice.push(childRel);
      } else {
        special.push(childRel);
      }
    }
  };
  walk(dir, '');
  if (over) problems.push(`the folder has more than ${MAX_ENTRIES} entries`);
  if (nodeModules) problems.push('the folder has a node_modules folder: an own module has none in this release; copy the code it needs into its folder');
  if (links.length > 0) problems.push(`the folder holds a link (${links.slice(0, 3).join(', ')}${links.length > 3 ? ', …' : ''}): an own module's files are its own, never links`);
  if (twice.length > 0) problems.push(`the folder holds a file with a second name (${twice.slice(0, 3).join(', ')}${twice.length > 3 ? ', …' : ''}): an own module's files are its own, one name each`);
  if (bytes > MAX_TREE_BYTES) problems.push(`the folder holds more than ${MAX_TREE_BYTES / (1024 * 1024)} MiB of files`);
  if (special.length > 0) problems.push(`the folder holds something that is neither a file nor a folder (${special.slice(0, 3).join(', ')}${special.length > 3 ? ', …' : ''}): an own module holds files only`);
  const blocking = over || links.length > 0 || twice.length > 0 || special.length > 0 || bytes > MAX_TREE_BYTES;
  return {problems, blocking};
}

module.exports = {pathRefusal, treeProblems, pkgProblems, scrub, inside, DEPENDENCY_FIELDS, MAX_ENTRIES, MAX_TREE_BYTES};
