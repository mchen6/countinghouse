'use strict';
// #344: an equality assertion over a validator pool's objects, failing,
// renders and diffs both sides (util.inspect, then a Myers diff of the whole
// graph). A slot holds its requests and so a check's input: module-loading
// 24's 20,000-item input made one such diff take 3+ GB and the main thread
// for minutes, which lost ~10 CI runners before #346's watcher caught the
// stack. In every test that uses the pool, a slot, the spare, a worker, a
// pool or a request is compared by reference (test/helpers/same-ref.js) or
// by a small identity (a thread id, an index), never by an equality
// assertion on the object itself. This reads those files' source.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EQUALITY = /assert\.(strictEqual|notStrictEqual|deepStrictEqual|notDeepStrictEqual|deepEqual|notDeepEqual|equal|notEqual)\(/g;
// an argument that is one of the pool's objects itself (not a field of it)
const BIG = [
  /^p(ool)?\d*\.slots\[[^\]]+\]$/, /^(p(ool)?\d*\.)?spare$/, /^(p(ool)?\d*\.)?(home|slot|pendingSlot)$/,
  /\.worker$/, /^p(ool)?\d*$/, /^req$/
];

function testFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') out.push(...testFiles(p)); } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// the top-level arguments of the call that starts at `from` (just past "(")
function argsAt(src, from) {
  const args = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote != null) {
      cur += ch;
      if (ch === '\\') { cur += src[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) {
      if (depth === 0) { args.push(cur.trim()); return args; }
      depth--;
    }
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  return args;
}

function offenders(src) {
  const out = [];
  for (const m of src.matchAll(EQUALITY)) {
    const [actual, expected] = argsAt(src, m.index + m[0].length);
    for (const a of [actual, expected]) {
      if (typeof(a) === 'string' && BIG.some((re) => re.test(a))) out.push(`${src.slice(0, m.index).split('\n').length}: ${m[0]}${actual}, ${expected}`);
    }
  }
  return out;
}

describe('validation 22: no equality assertion diffs a validator pool\'s objects (#344)', () => {
  it('the guard sees the forms it is for, and passes what it should', () => {
    assert.deepStrictEqual(offenders("assert.strictEqual(p.slots[0], spare, 'x');").length, 2);
    assert.deepStrictEqual(offenders("assert.notStrictEqual(p.slots[0], home, 'x');").length, 2);
    assert.deepStrictEqual(offenders('assert.deepStrictEqual(all(pool).map((s) => s.worker), workers);').length, 0, 'a mapped list is the next rule\'s');
    assert.deepStrictEqual(offenders('assert.strictEqual(pendingSlot.worker, null);').length, 1);
    assert.deepStrictEqual(offenders("assert.strictEqual(p.slots[0].compiled.get(c.key), 'all');").length, 0, 'a field\'s value is small');
    assert.deepStrictEqual(offenders("assert.strictEqual(spare.compiled.size, 0, 'x');").length, 0);
  });

  it('every test that uses the validator pool compares its objects by reference or by a small identity', () => {
    const files = testFiles(ROOT).filter((f) => /validator-pool|ValidatorPool/.test(fs.readFileSync(f, 'utf8')) && f !== __filename);
    assert.ok(files.length >= 5, files.join('\n'));
    const found = [];
    for (const f of files) for (const o of offenders(fs.readFileSync(f, 'utf8'))) found.push(`${path.relative(ROOT, f)}:${o}`);
    assert.deepStrictEqual(found, [], 'use sameRef/notSameRef (test/helpers/same-ref.js) or compare a thread id or an index');
  });

  it('nor maps a pool\'s slots to their workers for a deep comparison', () => {
    const files = testFiles(ROOT).filter((f) => /validator-pool|ValidatorPool/.test(fs.readFileSync(f, 'utf8')) && f !== __filename);
    const found = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/assert\.(deepStrictEqual|deepEqual|notDeepStrictEqual)\(([^\n]*)/g)) {
        if (/\.map\(\(?\w+\)?\s*=>\s*\w+\.worker\)/.test(m[2])) found.push(`${path.relative(ROOT, f)}: ${m[0].slice(0, 120)}`);
      }
    }
    assert.deepStrictEqual(found, []);
  });
});
