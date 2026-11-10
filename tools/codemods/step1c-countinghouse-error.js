#!/usr/bin/env node
// Step 1 (c) of the logger-and-errors spec (docs/superpowers/specs/
// 2026-11-09-logger-design.md §9): every error constructed in lib/, bin/ and
// framework.js becomes a CountinghouseError. Committed so the change can be
// re-run on its parent and compared:
//
//   node tools/codemods/step1c-countinghouse-error.js [repo]
//
// It rewrites, in every .js file git tracks under lib/ and bin/, and
// framework.js, except lib/countinghouse-error.js (hand-written: the class,
// the shims behind the module-facing globals, hopError) and
// lib/error-catalogue.js:
//   - `new CHError(`       -> `new CountinghouseError(`
//   - `new DeviceError(`   -> `CountinghouseError.device(`  (DeviceError's topic)
//   - `x instanceof DeviceError || x instanceof CHError` -> `x instanceof CountinghouseError`
//   - `const CHError = require('<p>countinghouse-error').CHError;` (and the
//     DeviceError one): the first becomes the CountinghouseError require,
//     any second is removed
//   - a file that used the old classes through the globals, with no require,
//     gets the CountinghouseError require (after its last top-level require)
//   - comments: CHError/DeviceError -> CountinghouseError; three mentions of
//     the old error-info JSON files -> the catalogue, one grammar fix (EXACT below)
// Lines that set the module-facing globals (`global.CHError = ...`) are left
// alone: step 1 (d) removes them. It then refuses (exit 1, nothing written)
// if any file still names CHError or DeviceError outside such a line, or
// uses CountinghouseError without requiring it. It prints what it changed.
'use strict';
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const REPO = path.resolve(process.argv[2] || '.');
const SKIP = new Set(['lib/countinghouse-error.js', 'lib/error-catalogue.js']);
const GLOBAL_LINE = /^\s*global\.(CHError|DeviceError)\s*=/;
const OLD = /\b(CHError|DeviceError)\b/;
const REQUIRE = /^const\s+(CHError|DeviceError)\s*=\s*require\((['"])((?:\.\.?\/)+(?:lib\/)?)countinghouse-error\2\)\.(CHError|DeviceError);[ \t]*\r?\n/gm;

// Comment text naming the retired JSON files, and one plural: [file, from, to].
const EXACT = [
  ['lib/auth/provider.js', 'reusing the existing CHError/error-info.*.json code taxonomy',
    'reusing the error catalogue\'s code taxonomy (lib/error-catalogue.js)'],
  ['lib/handler-ctx.js', 'each code\'s head text in error-info.*.json says', 'each code\'s head text in the error catalogue says'],
  ['lib/worker-message.js', '// preserve the original error-info.json code (locale-independent)',
    '// preserve the original catalogue code (locale-independent)'],
  // grammar: the old pair took a plural verb
  ['lib/mcp/gateway.js', '// CHError/DeviceError carry a locale-independent', '// A CountinghouseError carries a locale-independent']
];

const files = execFileSync('git', ['-C', REPO, 'ls-files', 'lib', 'bin', 'framework.js'], {encoding: 'utf8'})
  .split('\n').filter((f) => f.endsWith('.js') && !SKIP.has(f));

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
const problems = [];
const changed = [];
const counts = {construct: 0, device: 0, instanceofPairs: 0, requires: 0, requiresRemoved: 0, requiresAdded: 0, commentLines: 0, exact: 0};
const added = [];

for (const file of files) {
  const full = path.join(REPO, file);
  const before = fs.readFileSync(full, 'utf8');
  let s = before;

  for (const [f, from, to] of EXACT) {
    if (f !== file) continue;
    if (s.split(from).length !== 2) problems.push(`${file}: expected exactly one "${from}"`);
    s = s.replace(from, to);
    counts.exact++;
  }

  let seen = false;
  s = s.replace(REQUIRE, (m, name, quote, prefix) => {
    if (seen) { counts.requiresRemoved++; return ''; }
    seen = true;
    counts.requires++;
    return `const CountinghouseError = require(${quote}${prefix}countinghouse-error${quote}).CountinghouseError;\n`;
  });

  s = s.replace(/new CHError\(/g, () => { counts.construct++; return 'new CountinghouseError('; });
  s = s.replace(/new DeviceError\(/g, () => { counts.device++; return 'CountinghouseError.device('; });
  s = s.replace(/\b([A-Za-z_$][\w$]*) instanceof DeviceError \|\| \1 instanceof CHError\b/g,
    (m, v) => { counts.instanceofPairs++; return `${v} instanceof CountinghouseError`; });

  s = s.split('\n').map((line) => {
    if (!isComment(line) || !OLD.test(line)) return line;
    counts.commentLines++;
    return line.replace(/\b(CHError\/DeviceError|DeviceError\/CHError)\b/g, 'CountinghouseError')
      .replace(/\b(CHError|DeviceError)\b/g, 'CountinghouseError');
  }).join('\n');

  // A file that used the old classes through the globals (no require) gets
  // a require of its own, after its last top-level require (else after its
  // header comment), so it no longer depends on the globals step 1 (d) removes.
  const codeOf = (text) => text.split('\n').filter((l) => !isComment(l)).join('\n');
  if (/\bCountinghouseError\b/.test(codeOf(s)) && !/require\([^)]*countinghouse-error['"]\)\.CountinghouseError/.test(s)) {
    let rel = path.relative(path.dirname(file), 'lib/countinghouse-error').split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    const lines = s.split('\n');
    let at = -1;
    lines.forEach((l, i) => { if (/^(const|let|var)\s.*=\s*require\(/.test(l)) at = i; });
    if (at === -1) { at = 0; while (at < lines.length && isComment(lines[at])) at++; at--; }
    lines.splice(at + 1, 0, `const CountinghouseError = require('${rel}').CountinghouseError;`);
    s = lines.join('\n');
    counts.requiresAdded++;
    added.push(file);
  }

  s.split('\n').forEach((line, i) => {
    if (OLD.test(line) && !GLOBAL_LINE.test(line)) problems.push(`${file}:${i + 1}: still names the old class: ${line.trim()}`);
  });
  if (/\bCountinghouseError\b/.test(codeOf(s)) && !/require\([^)]*countinghouse-error['"]\)\.CountinghouseError/.test(codeOf(s))) {
    problems.push(`${file}: uses CountinghouseError without requiring it`);
  }
  if (s !== before) changed.push([file, s]);
}

if (problems.length > 0) {
  console.error(`step1c codemod: ${problems.length} problem(s), nothing written:`);
  problems.forEach((p) => console.error(`  ${p}`));
  process.exit(1);
}
changed.forEach(([file, s]) => fs.writeFileSync(path.join(REPO, file), s));
console.log(`step1c codemod: ${changed.length} files changed`);
console.log(`  new CHError( -> new CountinghouseError(: ${counts.construct}`);
console.log(`  new DeviceError( -> CountinghouseError.device(: ${counts.device}`);
console.log(`  instanceof pairs: ${counts.instanceofPairs}`);
console.log(`  requires rewritten: ${counts.requires}, removed (second require): ${counts.requiresRemoved}, added (used the globals): ${counts.requiresAdded} ${added.join(' ')}`);
console.log(`  comment lines: ${counts.commentLines}, exact comment replacements: ${counts.exact}`);
changed.forEach(([file]) => console.log(`    ${file}`));
