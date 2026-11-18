'use strict';
// docs/cli-and-api-reference.md's "CLI flags reference" lists every flag the
// runtime reads, and no other (M18): each key lib/cli-options.js reads from
// argv has a row, and each row is a key it reads. A flag added without its
// row fails here, as does a row left behind when a flag goes (#382 removed
// five; the table had also missed 17). Server-free.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// The section, from its heading to the next "## ".
function flagsSection() {
  const lines = fs.readFileSync(path.join(ROOT, 'docs', 'cli-and-api-reference.md'), 'utf8').split('\n');
  const start = lines.indexOf('## CLI flags reference');
  assert.ok(start >= 0, 'the reference has its "CLI flags reference" section');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return lines.slice(start + 1, end);
}

// The flags its table's rows name: `--name ...` or `--no-name`, first cell.
function documented() {
  const out = [];
  for (const line of flagsSection()) {
    const m = line.match(/^\| `--(?:no-)?([A-Za-z][A-Za-z0-9]*)/);
    if (m != null) out.push(m[1]);
  }
  return out;
}

// The keys lib/cli-options.js reads from argv: argv.name and argv['name'].
function read() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'cli-options.js'), 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/\bargv(?:\.([A-Za-z_$][\w$]*)|\[\s*'([A-Za-z_$][\w$]*)'\s*\])/g)) out.add(m[1] || m[2]);
  return out;
}

describe('validation 24: the CLI flags reference lists every flag the runtime reads, and no other', () => {
  it('reads some flags, and the table has rows', () => {
    assert.ok(read().size > 40, `cli-options reads ${read().size}`);
    assert.ok(documented().length > 40, `the table has ${documented().length} rows`);
  });

  it('documents each flag once', () => {
    const seen = new Set();
    const twice = documented().filter((f) => (seen.has(f) ? true : (seen.add(f), false)));
    assert.deepStrictEqual(twice, []);
  });

  it('has a row for every flag lib/cli-options.js reads', () => {
    const rows = new Set(documented());
    assert.deepStrictEqual([...read()].filter((k) => !rows.has(k)).sort(), [], 'flags with no row');
  });

  it('has no row for a flag nothing reads (a removed flag\'s row goes with it)', () => {
    const keys = read();
    assert.deepStrictEqual(documented().filter((f) => !keys.has(f)).sort(), [], 'rows for flags nothing reads');
  });
});
