#!/usr/bin/env node
// Step 1 (d2) of the logger-and-errors spec (docs/superpowers/specs/
// 2026-11-09-logger-design.md §9): `topic` is retired, and the device form
// with it, so every `CountinghouseError.device(` becomes
// `new CountinghouseError(` (the same arguments; without a topic the two are
// the same error). Committed so the change can be re-run on its parent and
// compared:
//
//   node tools/codemods/step1d2-device-form.js [repo]
//
// It rewrites every .js file git tracks under lib/ and bin/, and
// framework.js, except lib/countinghouse-error.js (hand-written: the class
// itself). It then refuses (exit 1, nothing written) if any file still says
// `CountinghouseError.device`, and prints what it changed.
'use strict';
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const REPO = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const SKIP = new Set(['lib/countinghouse-error.js']);
const FROM = /CountinghouseError\.device\(/g;
const TO = 'new CountinghouseError(';

const files = execFileSync('git', ['-C', REPO, 'ls-files', '--', 'lib', 'bin', 'framework.js'], {encoding: 'utf8'})
  .split('\n').filter((f) => f.endsWith('.js') && !SKIP.has(f));

const changed = [];
let total = 0;
for (const f of files) {
  const before = fs.readFileSync(path.join(REPO, f), 'utf8');
  const n = (before.match(FROM) || []).length;
  if (n === 0) continue;
  changed.push({f, n, after: before.replace(FROM, TO)});
  total += n;
}

const left = changed.filter((c) => c.after.includes('CountinghouseError.device'))
  .concat(files.filter((f) => !changed.some((c) => c.f === f))
    .filter((f) => fs.readFileSync(path.join(REPO, f), 'utf8').includes('CountinghouseError.device')).map((f) => ({f})));
if (left.length > 0) {
  console.error(`step1d2 codemod: refusing, still names CountinghouseError.device: ${left.map((c) => c.f).join(' ')}`);
  process.exit(1);
}
for (const c of changed) fs.writeFileSync(path.join(REPO, c.f), c.after);
console.log(`step1d2 codemod: ${changed.length} files changed`);
console.log(`  CountinghouseError.device( -> new CountinghouseError(: ${total}`);
for (const c of changed) console.log(`    ${c.f}: ${c.n}`);
