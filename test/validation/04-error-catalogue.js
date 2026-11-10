// The error catalogue (logger-design §5.3), step 1 (a): one table replacing
// lib/error-info.*.json (removed in step 1 (c)). Every code lib/ raises is in it, every entry is
// used, every entry is complete. Like sandbox/05's built-in check: a code
// added to lib/ without an entry, or an entry nothing raises, fails here.
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..', '..');
const KINDS = ['caller', 'module', 'operator', 'runtime'];

// Every .js file under lib/, plus framework.js and bin/.
function sources() {
  const out = [path.join(ROOT, 'framework.js')];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  })(path.join(ROOT, 'lib'));
  fs.readdirSync(path.join(ROOT, 'bin')).filter((f) => f.endsWith('.js')).forEach((f) => out.push(path.join(ROOT, 'bin', f)));
  return out.filter((f) => !f.endsWith(path.join('lib', 'error-catalogue.js')));
}

describe('validation 04: the error catalogue (logger-design §5.3)', () => {
  const {CODES} = require('../../lib/error-catalogue');
  const text = sources().map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  it('has every code lib/ constructs an error with', () => {
    const raised = new Set();
    const re = /new (?:CHError|DeviceError|CountinghouseError)\(\s*['"]([A-Z][A-Z0-9_]+)['"]|CountinghouseError\.(?:device|create)\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g;
    let m;
    while ((m = re.exec(text)) != null) raised.add(m[1] || m[2]);
    assert.ok(raised.size > 50, `premise: found ${raised.size} raised codes`);
    const missing = [...raised].filter((c) => !Object.prototype.hasOwnProperty.call(CODES, c));
    assert.deepStrictEqual(missing, []);
  });

  it('has no entry that nothing in lib/ names', () => {
    const unused = Object.keys(CODES).filter((c) => !new RegExp(`['"\`]${c}['"\`]`).test(text));
    assert.deepStrictEqual(unused, []);
  });

  it('gives every entry a kind, retryable, httpStatus, mcpCode, and en and zh text', () => {
    for (const [code, e] of Object.entries(CODES)) {
      assert.ok(/^[A-Z][A-Z0-9_]+$/.test(code), code);
      assert.ok(KINDS.includes(e.kind), `${code}: kind ${e.kind}`);
      assert.strictEqual(typeof(e.retryable), 'boolean', code);
      assert.ok(Number.isInteger(e.httpStatus) && e.httpStatus >= 400 && e.httpStatus <= 599, `${code}: httpStatus ${e.httpStatus}`);
      assert.strictEqual(e.mcpCode, null, code);
      assert.ok(typeof(e.en) === 'string' && e.en.length > 0, `${code}: en`);
      assert.ok(typeof(e.zh) === 'string' && e.zh.length > 0, `${code}: zh`);
    }
  });
});
