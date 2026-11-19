'use strict';
// Checks over a module's directory that the sandbox relies on
// (docs/superpowers/specs/2026-10-15-module-sandbox-foundation-design.md,
// section 2): every dependency installed inside the module, no native code,
// and install scripts reported. Run by countinghouse-validate and again at
// load time (lib/module-sandbox-config.js), which is the check that decides.
const fs   = require('fs');
const path = require('path');
// (taken at load: this file runs in a validation worker after its lockdown
// too, where a require then is a late runtime load; sandbox 66, 67)
const {pathToFileURL, fileURLToPath} = require('url');

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

// Each string value written under a top-level "main" key of a package.json
// text JSON.parse has read, a duplicate included (Node's own reader can keep
// another than JSON.parse's last): by depth, strings skipped whole.
function topLevelMains(raw) {
  const out = [];
  let depth = 0;
  const stringEnd = (at) => {
    let j = at + 1;
    while (j < raw.length && raw[j] !== '"') j += (raw[j] === '\\') ? 2 : 1;
    return j + 1;
  };
  const skipWs = (at) => {
    let k = at;
    while (k < raw.length && ' \t\n\r'.includes(raw[k])) k++;
    return k;
  };
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '"') {
      const end = stringEnd(i);
      const k = skipWs(end);
      if (depth === 1 && raw[k] === ':') {
        let key = null;
        try { key = JSON.parse(raw.slice(i, end)); } catch (e) { key = null; }
        const v = skipWs(k + 1);
        if (key === 'main' && raw[v] === '"') {
          try {
            const value = JSON.parse(raw.slice(v, stringEnd(v)));
            if (typeof(value) === 'string') out.push(value);
          } catch (e) { /* not a string Node reads either */ }
        }
      }
      i = end;
      continue;
    }
    if (raw[i] === '{' || raw[i] === '[') depth++;
    else if (raw[i] === '}' || raw[i] === ']') depth--;
    i++;
  }
  return out;
}

// Whether a package.json's "main" (any written) leads outside the module
// root, read as Node's ES resolver reads it: a URL
// relative to the package.json, so a backslash, an escape or a stripped tab
// is no way out; one that is no path leads outside. Under --moduleSandbox
// enforce such a package is refused at load: Node picks a "main" in native
// code, past every check, and whether its target exists would be an answer
// (its index taken when it names nothing); the module root is read-only
// there, so the check at load holds (the _stat PR, the reviewer's ruling).
function mainLeadsOutside(root, pkgFile, raw) {
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  const base = pathToFileURL(pkgFile).href;
  // (both ways Node reads one: as a URL relative to the package.json, and
  // as a path resolved from its directory, which takes an absolute "main"
  // and a '#' or '?' as they are; either leading out is refused, and so is
  // one that names the root itself, in any spelling: Node's native step
  // resolves the path first and then tries it with each extension,
  // <root>.js beside the root (Fable's pass on #451))
  const leads = (to) => to === root || !inside(root, to);
  for (const main of topLevelMains(text)) {
    if (main === '') continue;
    let asUrl;
    try { asUrl = path.resolve(fileURLToPath(new URL(`./${main}`, base))); } catch (e) { return true; }
    if (leads(asUrl) || leads(path.resolve(path.dirname(pkgFile), main))) return true;
  }
  return false;
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
    const real = fs.realpathSync.native(dir);
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
      const realFound = fs.realpathSync.native(found);
      if (!inside(root, realFound)) {
        return problems.push(`dependency "${name}" (needed by ${label}) resolves outside the module, to ${realFound}`);
      }
      walk(realFound, path.relative(root, realFound) || '.');
    });
  })(root, 'the module');
}

// (package.json in any case: on a file system that folds case Node opens
// PACKAGE.JSON as it)
// (and by a file system's Unicode folding, which takes a long s, U+017F,
// for an s: both cases compared, after NFC; and with the default-ignorable
// code points HFS+ skips when it compares names taken out first)
const IGNORABLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8]/g;
const isManifest = (name) => {
  const n = name.replace(IGNORABLE, '').normalize('NFC');
  return n.toLowerCase() === 'package.json' || n.toUpperCase() === 'PACKAGE.JSON';
};

function checkFiles(root, problems, warnings, links, outsideMains) {
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
        // (one whose target can't be resolved -- dangling, a loop -- could
        // become a directory link later: listed with them)
        // (a package.json that is a link: Node reads its "main" against the
        // link's own directory, which no check of its target sees)
        let target;
        try { target = fs.realpathSync.native(full); } catch (e) { links.broken.push(rel); return; }
        // (one leading outside is that problem alone, said once)
        if (!inside(root, target)) return problems.push(`${rel} is a symlink to ${target}, outside the module`);
        if (isManifest(ent.name)) { links.manifests.push(rel); return; }
        // (a link to a directory inside, listed: under --moduleSandbox
        // enforce none is allowed, since Node's ES resolver reads a
        // package's "main" against the link's own path, past every check;
        // a link to a file, node_modules/.bin's, is no such base)
        else {
          let st = null;
          try { st = fs.statSync(full); } catch (e) { st = null; }
          if (st != null && st.isDirectory()) links.dirs.push(rel);
        }
        return;
      }
      if (ent.isDirectory()) return walk(full);
      if (ent.name.endsWith('.node')) problems.push(`native addon ${rel} -- modules may not contain native code`);
      if (ent.name === 'binding.gyp') problems.push(`${rel} builds native code -- modules may not contain native code`);
      if (isManifest(ent.name)) {
        // (the very file matched, a case variant's too, read once: parsed,
        // and its "main" judged, from the same text; the high review of
        // #451)
        let raw;
        try { raw = fs.readFileSync(full, 'utf8'); } catch (e) { return problems.push(`${rel} cannot be read: ${e.code}`); }
        let pkg;
        try { pkg = JSON.parse(raw) || {}; } catch (e) { return problems.push(`${rel} cannot be parsed: ${e.message}`); }
        if (pkg.gypfile === true) problems.push(`${rel} sets "gypfile": true -- modules may not contain native code`);
        if (mainLeadsOutside(root, full, raw)) outsideMains.push(rel);
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
  const root = fs.realpathSync.native(path.resolve(moduleRoot));
  const problems = [];
  const warnings = [];
  const links = {dirs: [], broken: [], manifests: []};
  const outsideMains = [];
  checkDependencies(root, problems);
  checkFiles(root, problems, warnings, links, outsideMains);
  return {problems: problems, warnings: warnings, dirLinks: links.dirs, brokenLinks: links.broken, manifestLinks: links.manifests, outsideMains: outsideMains};
}

module.exports = {checkTree};
