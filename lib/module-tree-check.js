// Checks over a module's directory that the sandbox relies on
// (docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 2): every dependency installed inside the module, no native code,
// and install scripts reported. Run by countinghouse-validate and again at
// load time (lib/module-sandbox-config.js), which is the check that decides.
const fs   = require('fs');
const path = require('path');

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

// {pkg: null} when there is no package.json (fine); {error} when there is one
// that cannot be read or parsed -- reported, never treated as empty.
function readPkg(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'package.json'), 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? {pkg: null} : {error: e.message};
  }
  try { return {pkg: JSON.parse(text)}; } catch (e) { return {error: e.message}; }
}

function inside(root, p) {
  return p === root || p.startsWith(root + path.sep);
}

// Node's lookup: <dir>/node_modules/<name>, then each parent's, stopping at
// the module root -- a dependency found above the root is outside it.
function findDependency(root, fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

function checkDependencies(root, problems) {
  const seen = new Set();
  (function walk(dir, label) {
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    const read = readPkg(dir);
    if (read.error != null) return;               // checkFiles reports it
    const pkg = read.pkg || {};
    Object.keys(pkg.dependencies || {}).forEach((name) => {
      const found = findDependency(root, dir, name);
      if (found == null) {
        return problems.push(`dependency "${name}" (needed by ${label}) is not installed inside the module -- ` +
                             'install it into the module\'s own node_modules (npm install --prefix <module>)');
      }
      const realFound = fs.realpathSync(found);
      if (!inside(root, realFound)) {
        return problems.push(`dependency "${name}" (needed by ${label}) resolves outside the module, to ${realFound}`);
      }
      walk(realFound, path.relative(root, realFound) || '.');
    });
  })(root, 'the module');
}

function checkFiles(root, problems, warnings) {
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch (e) {
      return problems.push(`cannot read ${path.relative(root, dir) || '.'}: ${e.code}`);
    }
    entries.forEach((ent) => {
      const full = path.join(dir, ent.name);
      const rel  = path.relative(root, full);
      if (ent.isSymbolicLink()) {
        // A link that stays inside the module needs nothing: its target is
        // scanned where it really lives. One that leaves it is not ours to
        // inspect. A dangling link points at nothing.
        let target;
        try { target = fs.realpathSync(full); } catch (e) { return; }
        if (!inside(root, target)) problems.push(`${rel} is a symlink to ${target}, outside the module`);
        return;
      }
      if (ent.isDirectory()) return walk(full);
      if (ent.name.endsWith('.node')) problems.push(`native addon ${rel} -- modules may not contain native code`);
      if (ent.name === 'binding.gyp') problems.push(`${rel} builds native code -- modules may not contain native code`);
      if (ent.name === 'package.json') {
        const read = readPkg(dir);
        if (read.error != null) return problems.push(`${rel} cannot be parsed: ${read.error}`);
        const pkg = read.pkg || {};
        if (pkg.gypfile === true) problems.push(`${rel} sets "gypfile": true -- modules may not contain native code`);
        INSTALL_SCRIPTS.forEach((s) => {
          if (pkg.scripts != null && pkg.scripts[s] != null) {
            warnings.push(`${path.relative(root, dir) || '.'} has a "${s}" script, which npm runs at install time`);
          }
        });
      }
    });
  })(root);
}

function checkTree(moduleRoot) {
  const root = fs.realpathSync(path.resolve(moduleRoot));
  const problems = [];
  const warnings = [];
  checkDependencies(root, problems);
  checkFiles(root, problems, warnings);
  return {problems: problems, warnings: warnings};
}

module.exports = {checkTree};
