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
const {isUtf8} = require('buffer');

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

// A package.json's text parsed as Node's reader does: past a leading BOM.
const parseManifest = (text) => JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);

// The entry dir/package.json opens: a case variant's own name on a mount
// that folds case; 'package.json' when none other is it.
function matchedName(dir) {
  let target;
  try { target = fs.statSync(path.join(dir, 'package.json')); } catch (e) { return 'package.json'; }
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 'package.json'; }
  for (const n of names) {
    if (n === 'package.json' || !isManifest(n)) continue;
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.dev === target.dev && st.ino === target.ino) return n;
    } catch (e) { /* gone */ }
  }
  return 'package.json';
}

// A file read only if it is a plain one (the single-identity profile's
// static validation of a user's own module, B-own-runtime): opened without
// following a link and without blocking (a FIFO never holds the thread),
// then judged on the descriptor itself -- a regular file, one name, at most
// maxBytes -- else ENOTPLAIN. -> its bytes.
const PLAIN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
function readPlainFile(file, maxBytes) {
  const fd = fs.openSync(file, PLAIN_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > maxBytes) throw Object.assign(new Error('not a plain file'), {code: 'ENOTPLAIN'});
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}
const PLAIN_MAX = 4 * 1024 * 1024;   // (a manifest, plainly read: far past any real one)

// {pkg: null} when there is no package.json (fine); {error} when there is one
// that cannot be read or parsed -- reported, never treated as empty. plain:
// read with readPlainFile, and no error's own text kept (it can quote the
// file).
function readPkg(dir, plain = false) {
  let text;
  try { text = plain ? readPlainFile(path.join(dir, 'package.json'), PLAIN_MAX).toString('utf8') : fs.readFileSync(path.join(dir, 'package.json'), 'utf8'); } catch (e) {
    // (a directory, a loop, or nothing there: absent, as for Node)
    return (e.code === 'ENOENT' || e.code === 'EISDIR' || e.code === 'ELOOP' || e.code === 'ENOTDIR') ? {pkg: null} : {error: e.message, unread: e.code};
  }
  try { return {pkg: parseManifest(text)}; } catch (e) { return {error: plain ? null : e.message}; }
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

// The keys among Node's resolution fields a package.json text writes twice
// at its top level, and those it writes with an escape: JSON.parse keeps
// the last copy, Node's own reader can keep another (one of a type it
// doesn't accept is skipped), and JSON.parse decodes "\u0069mports" where
// Node's reader matches the key as written -- either way the sandbox's
// resolver and Node's could read the package differently. Refused under
// --moduleSandbox enforce at load, said under audit (the high review of
// #465, round 3; the medium review of 9685cb1f) -- never a second reader
// written to match Node's. And, ruled K2, a backslash escape in the string
// value of "name", "main" or "type", which Node's reader decodes itself (a
// lone surrogate, say, it may take otherwise than JSON.parse): reported as
// "<file>'s "<key>" value". Node's reader hands "exports" and "imports" back
// as their raw text, which JSON.parse reads as the resolver does, so what
// is nested in them is read alike.
const VALUE_KEYS = ['name', 'main', 'type'];
const RESOLUTION_KEYS = ['imports', 'exports', 'name', 'main', 'type'];
function oddKeys(raw) {
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  const seen = new Map();
  const escaped = new Set();
  const escapedValues = new Set();
  let depth = 0;
  const stringEnd = (at) => {
    let j = at + 1;
    while (j < text.length && text[j] !== '"') j += (text[j] === '\\') ? 2 : 1;
    return j + 1;
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') {
      const end = stringEnd(i);
      let k = end;
      while (k < text.length && ' \t\n\r'.includes(text[k])) k++;
      if (depth === 1 && text[k] === ':') {
        let key = null;
        try { key = JSON.parse(text.slice(i, end)); } catch (e) { key = null; }
        if (RESOLUTION_KEYS.includes(key)) {
          seen.set(key, (seen.get(key) || 0) + 1);
          if (text.slice(i + 1, end - 1).includes('\\')) escaped.add(key);
          let v = k + 1;
          while (v < text.length && ' \t\n\r'.includes(text[v])) v++;
          if (VALUE_KEYS.includes(key) && text[v] === '"' && text.slice(v + 1, stringEnd(v) - 1).includes('\\')) escapedValues.add(key);
        }
      }
      i = end;
      continue;
    }
    if (text[i] === '{' || text[i] === '[') depth++;
    else if (text[i] === '}' || text[i] === ']') depth--;
    i++;
  }
  return {twice: RESOLUTION_KEYS.filter((key) => (seen.get(key) || 0) > 1), escaped: RESOLUTION_KEYS.filter((key) => escaped.has(key)),
    escapedValues: VALUE_KEYS.filter((key) => escapedValues.has(key))};
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

function checkDependencies(root, problems, plain = false) {
  const seen = new Set();
  (function walk(dir, label) {
    const real = fs.realpathSync.native(dir);
    if (seen.has(real)) return;
    seen.add(real);
    const read = readPkg(dir, plain);
    // (said here too, once: what readPkg opened -- a linked package.json, a
    // case variant on a mount that folds case -- checkFiles may not have
    // parsed; the high review of #452)
    if (read.error != null) {
      // (in the file check's own words and by the matched entry's own name,
      // so said once)
      const rel = path.relative(root, path.join(dir, matchedName(dir)));
      const said = plain ? (read.unread != null ? `${rel} cannot be read` : `${rel} cannot be parsed`)
        : (read.unread != null ? `${rel} cannot be read: ${read.unread}` : `${rel} cannot be parsed: ${read.error}`);
      if (!problems.includes(said)) problems.push(said);
      return;
    }
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
// for an s: both cases compared, after NFC and after NFKC (ZFS's formKC
// and formKD, a fullwidth letter); and with the default-ignorable code
// points HFS+ and Linux casefold skip when they compare names taken out
// first, those beyond the BMP too: tags, shorthand format controls, musical
// format controls; Fable's pass on #452, F4)
const IGNORABLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/gu;
const isManifest = (name) => {
  // (a plain ASCII name, nearly every one, compared as it is)
  if (/^[\x20-\x7E]*$/.test(name)) return name.toLowerCase() === 'package.json';
  const bare = name.replace(IGNORABLE, '');
  return ['NFC', 'NFKC'].some((form) => {
    const n = bare.normalize(form).replace(IGNORABLE, '');
    return n.toLowerCase() === 'package.json' || n.toUpperCase() === 'PACKAGE.JSON';
  });
};

function checkFiles(root, problems, warnings, links, outsideMains, duplicates, escapedKeys, notUtf8, plain = false) {
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
        try {
          const bytes = plain ? readPlainFile(full, PLAIN_MAX) : fs.readFileSync(full);
          // (bytes that aren't UTF-8: a 'utf8' read makes U+FFFD of them and
          // JSON.parse takes the text, where Node's reader throws; ruled K2)
          if (!isUtf8(bytes)) notUtf8.push(rel);
          raw = bytes.toString('utf8');
        } catch (e) {
          const said = plain ? `${rel} cannot be read` : `${rel} cannot be read: ${e.code}`;
          if (!problems.includes(said)) problems.push(said);
          return;
        }
        // (its "main" judged from the text, parsed or not, wherever: a
        // Linux mount can fold case too; and one JSON.parse rejects is
        // refused on every platform, a case variant too, as Node's own
        // reader can take a "main" past a value JSON.parse rejects, which
        // the scan may miss; Fable's pass on #452, F3 -- parsed, as Node's
        // reader does, past a BOM)
        if (mainLeadsOutside(root, full, raw)) outsideMains.push(rel);
        const odd = oddKeys(raw);
        odd.twice.forEach((key) => duplicates.push(`${rel}'s "${key}"`));
        odd.escaped.forEach((key) => escapedKeys.push(`${rel}'s "${key}"`));
        odd.escapedValues.forEach((key) => escapedKeys.push(`${rel}'s "${key}" value`));
        let pkg;
        try { pkg = parseManifest(raw) || {}; } catch (e) {
          // (once: the dependency check may have said it)
          const said = plain ? `${rel} cannot be parsed` : `${rel} cannot be parsed: ${e.message}`;
          if (!problems.includes(said)) problems.push(said);
          return;
        }
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

// opts.plain: every file read with readPlainFile, no error's own text kept
// (the profile's static validation)
function checkTree(moduleRoot, opts = {}) {
  const plain = opts != null && opts.plain === true;
  const root = fs.realpathSync.native(path.resolve(moduleRoot));
  const problems = [];
  const warnings = [];
  const links = {dirs: [], broken: [], manifests: []};
  const outsideMains = [];
  const duplicates = [];
  const escapedKeys = [];
  const notUtf8 = [];
  checkDependencies(root, problems, plain);
  checkFiles(root, problems, warnings, links, outsideMains, duplicates, escapedKeys, notUtf8, plain);
  return {problems: problems, warnings: warnings, dirLinks: links.dirs, brokenLinks: links.broken, manifestLinks: links.manifests, outsideMains: outsideMains,
    duplicateKeys: duplicates, escapedKeys: escapedKeys, notUtf8: notUtf8};
}

module.exports = {checkTree, readPlainFile};
