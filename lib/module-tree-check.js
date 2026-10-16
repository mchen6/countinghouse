// Checks over a module's directory that the sandbox relies on
// (docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 2): every dependency installed inside the module, no native code,
// and install scripts reported. Run by countinghouse-validate and again at
// load time (lib/module-sandbox-config.js), which is the check that decides.
const fs   = require('fs');
const path = require('path');

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { return null; }
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
    const pkg = readPkg(dir) || {};
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
      walk(found, path.relative(root, found) || '.');
    });
  })(root, 'the module');
}

function checkFiles(root, problems, warnings) {
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch (e) { return; }
    entries.forEach((ent) => {
      const full = path.join(dir, ent.name);
      const rel  = path.relative(root, full);
      if (ent.isSymbolicLink()) return;            // checkDependencies reports links that leave the tree
      if (ent.isDirectory()) return walk(full);
      if (ent.name.endsWith('.node')) problems.push(`native addon ${rel} -- modules may not contain native code`);
      if (ent.name === 'binding.gyp') problems.push(`${rel} builds native code -- modules may not contain native code`);
      if (ent.name === 'package.json') {
        const pkg = readPkg(dir) || {};
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
