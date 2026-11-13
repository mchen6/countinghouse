// Every package the shipped runtime requires is one it ships with (reviewer,
// 2026-11-12). lib/remote/client.js loaded @modelcontextprotocol/sdk, which was
// a devDependency: the repository's own tests had it, an installed
// countinghouse (npm pack, then npm ci in a client's home) did not, and every
// remote call failed with "Cannot find module". ch-local's acceptance run from
// tarballs found it. A static scan: each require()/import specifier in lib/,
// bin/ and framework.js that is not relative must be a Node builtin or a
// package in "dependencies" (optionalDependencies too), or one of the few
// OPTIONAL packages below, each with its reason.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {builtinModules} = require('module');

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const shipped = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]);
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
// Packages the runtime loads only on an opt-in path, in a guarded require
// that says how to install them; deliberately in no dependency field.
const OPTIONAL = {
  nano: 'lib/couchdb-adapter: --authProvider couchdb only; requireNano() says to npm install nano'
};

function sources() {
  const out = [path.join(ROOT, 'framework.js')];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'bin'));
  return out;
}

// The package a bare specifier names: @scope/name or name.
const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
const SPECIFIERS = [/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g, /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, /^\s*import\s[^'"]*(['"])([^'"]+)\1/gm, /^\s*export\s[^'"]*\sfrom\s*(['"])([^'"]+)\1/gm];

describe('validation 11: the shipped runtime requires only builtins and its own dependencies', () => {
  it('finds the files and their specifiers', () => {
    assert.ok(sources().length > 20);
  });

  it('every non-relative specifier is a builtin or in dependencies', () => {
    const missing = [];
    for (const file of sources()) {
      // Comments say a lot of require('...') that is not code.
      const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      for (const re of SPECIFIERS) {
        for (const m of text.matchAll(re)) {
          const spec = m[2];
          if (spec.startsWith('.') || spec.startsWith('/') || builtins.has(spec) || builtins.has(spec.split('/')[0])) continue;
          if (!shipped.has(packageOf(spec)) && !Object.prototype.hasOwnProperty.call(OPTIONAL, packageOf(spec))) missing.push(`${path.relative(ROOT, file)}: ${spec}`);
        }
      }
    }
    assert.deepStrictEqual(missing, [], 'required at run time but not in dependencies');
  });
});
