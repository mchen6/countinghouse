'use strict';
// docs/module-development.md's two reference tables stay whole (M18):
// - "Declarations at a glance": every key an action, its resource and a
//   prompt may carry in the meta-schema (spec/schema.json) has a row, and
//   every row's pointer resolves there;
// - "`package.json`: the `countinghouse` keys": every key lib/ reads from a
//   module's package.json `countinghouse` object has a row, and no row names
//   one nothing reads.
// A key added to the meta-schema or read by lib/ without its row fails here,
// as does a row left behind when one goes. The tables' links resolve too.
// Server-free.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'module-development.md');
const doc = fs.readFileSync(DOC, 'utf8');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'schema.json'), 'utf8'));

const ACTION = '#/properties/device/properties/serviceList/patternProperties/^urn:[\\S]{1,64}:serviceID:[\\S]{1,64}$/properties/actionList/items';
const PROMPT = '#/properties/device/properties/promptList/items';

// The text of a section, from its heading to the next heading of its level or above.
function section(heading) {
  const lines = doc.split('\n');
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `the doc has the heading ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m != null && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n');
}

// A table's body rows, each as its cells (the header and the rule left out).
const rows = (text) => text.split('\n').filter((l) => l.startsWith('| ') && !/^\|\s*-/.test(l))
  .slice(1).map((l) => l.slice(1, -1).split(' | ').map((c) => c.trim()));
const code = (cell) => { const m = cell.match(/^`([^`]+)`/); return m != null ? m[1] : null; };

// RFC 6901, from a '#'-rooted pointer.
function resolve(pointer) {
  let at = schema;
  for (const raw of pointer.replace(/^#\/?/, '').split('/').filter((s) => s !== '')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (at == null || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

// GitHub's heading anchors: lower case, punctuation out, spaces to hyphens.
const slug = (h) => h.replace(/^#+\s*/, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
const anchorsOf = (text) => new Set(text.split('\n').filter((l) => /^#+ /.test(l)).map(slug));

describe('validation 23: module-development\'s declaration tables match the meta-schema and lib/', () => {
  describe('Declarations at a glance', () => {
    const text = section('### Declarations at a glance');
    const table = rows(text);

    it('defines its two prefixes as the test reads them', () => {
      assert.ok(text.includes(`\`ACTION\` is\n  \`${ACTION}\``), 'ACTION as written');
      assert.ok(text.includes(`\`PROMPT\` is \`${PROMPT}\``), 'PROMPT as written');
      assert.ok(resolve(ACTION) != null && resolve(PROMPT) != null, 'both resolve');
    });

    it('every row\'s pointer resolves in spec/schema.json, and names the row\'s key', () => {
      assert.ok(table.length > 0, 'the table has rows');
      for (const [declCell, ptrCell] of table) {
        const decl = code(declCell);
        const ptr = code(ptrCell).replace(/^ACTION/, ACTION).replace(/^PROMPT/, PROMPT);
        assert.notStrictEqual(resolve(ptr), undefined, `${decl}: ${ptr} resolves`);
        assert.strictEqual(ptr.split('/').pop(), decl.split('.').pop(), `${decl}: its pointer ends in its key`);
      }
    });

    it('has a row for every key of an action, its resource and a prompt, and for promptList', () => {
      const expected = [
        ...Object.keys(resolve(`${ACTION}/properties`)).map((k) => `${ACTION}/properties/${k}`),
        ...Object.keys(resolve(`${ACTION}/properties/resource/properties`)).map((k) => `${ACTION}/properties/resource/properties/${k}`),
        ...Object.keys(resolve(`${PROMPT}/properties`)).map((k) => `${PROMPT}/properties/${k}`),
        '#/properties/device/properties/promptList'
      ].sort();
      const listed = table.map(([, ptrCell]) => code(ptrCell).replace(/^ACTION/, ACTION).replace(/^PROMPT/, PROMPT)).sort();
      assert.deepStrictEqual(listed, expected);
    });

    it('says what the meta-schema says: an action, a resource and a prompt refuse other keys', () => {
      for (const p of [ACTION, `${ACTION}/properties/resource`, PROMPT]) assert.strictEqual(resolve(p).additionalProperties, false, p);
      assert.match(text, /An action, a resource and a prompt refuse any other key\./);
    });

    it('marks as required exactly the keys the meta-schema requires', () => {
      const required = new Set([
        ...resolve(ACTION).required,
        ...resolve(`${ACTION}/properties/resource`).required.map((k) => `resource.${k}`),
        ...resolve(PROMPT).required.map((k) => `prompt.${k}`)
      ]);
      const marked = new Set(table.filter((r) => /^Required\./.test(r[2])).map((r) => code(r[0])));
      assert.deepStrictEqual([...marked].sort(), [...required].sort());
    });
  });

  describe('`package.json`: the `countinghouse` keys', () => {
    const text = section('## `package.json`: the `countinghouse` keys');
    const table = rows(text);

    // Every .js file under lib/.
    function sources() {
      const out = [];
      (function walk(dir) {
        for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.js')) out.push(p);
        }
      })(path.join(ROOT, 'lib'));
      return out;
    }

    it('has a row for every key lib/ reads from a module\'s countinghouse object, and no other', () => {
      const read = new Set();
      for (const f of sources()) {
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/\b(?:pkg|packageInfo|pinned)\.countinghouse\.([A-Za-z_$][\w$]*)/g)) read.add(m[1]);
      }
      assert.ok(read.size > 0, 'lib/ reads some');
      assert.deepStrictEqual(table.map((r) => code(r[0])).sort(), [...read].sort());
    });
  });

  it('every link in both tables resolves', () => {
    const own = anchorsOf(doc);
    const text = `${section('### Declarations at a glance')}\n${section('## `package.json`: the `countinghouse` keys')}`;
    const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    assert.ok(links.length > 0);
    for (const link of links) {
      const [file, anchor] = link.split('#');
      if (file === '') { assert.ok(own.has(anchor), `#${anchor} is a heading here`); continue; }
      const target = path.resolve(path.dirname(DOC), file);
      assert.ok(fs.existsSync(target), `${file} exists`);
      if (anchor != null) assert.ok(anchorsOf(fs.readFileSync(target, 'utf8')).has(anchor), `${link}: #${anchor} is a heading there`);
    }
  });
});
