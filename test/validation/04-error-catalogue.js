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

  // The sentence a no-form settings answer gains when the asking session's own lower value is why the terminal
  // command it names would not move it (lib/settings-tool.js withOwnLower): business's words, word for word. The
  // answers' codes and catalogue texts are unchanged; this is appended only in that case (test/sessions/10).
  it('the own-lower sentence: business\'s words', () => {
    assert.deepStrictEqual(require('../../lib/settings-tool').OWN_LOWER, {
      lead: 'This session keeps its own lower value ({current}), so that command alone won\'t change {name} here: ',
      restart: 'after it, restart your client to get a session with the new value.',
      ask: 'after it, ask again here to raise this session\'s value too.',
      paused: 'after it, ask again here once the pause on new questions ends (at most 30 minutes), or restart your client.',
      later: ' A value above what this runtime started with takes effect when it next starts.'
    });
  });

  // M6 (#413 rev 3 section 11): a module, never a pack, in the texts
  it('names a module, never a pack: the section 11 texts', () => {
    assert.strictEqual(CODES.PART_MISSING.en, 'A module this one calls is not installed or not available, so it was not loaded');
    assert.strictEqual(CODES.TOOL_NAME_TAKEN.en, 'A module\'s tool name is already taken by another tool, so the module was not loaded');
    assert.strictEqual(CODES.PROMPT_NAME_TAKEN.en, 'A module\'s prompt name is already taken by another prompt, so the module was not loaded');
    const saysPack = Object.entries(CODES).filter(([, e]) => /\bpacks?\b/i.test(e.en)).map(([c]) => c);
    assert.deepStrictEqual(saysPack, []);
  });

  // (the runtime's own subscription total: not its request limit, which
  // RUNTIME_BUSY says; retried once one closes)
  it('says the runtime\'s subscription total as it is', () => {
    assert.deepStrictEqual(CODES.SUBSCRIPTIONS_FULL, {kind: 'runtime', retryable: true, httpStatus: 503, mcpCode: null,
      en: 'The runtime has as many subscriptions open as it allows; retry once one closes'});
  });

  it('has every code lib/ constructs an error with', () => {
    const raised = new Set();
    const re = /new CountinghouseError\(\s*['"]([A-Z][A-Z0-9_]+)['"]|CountinghouseError\.create\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g;
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

  it('is the only table: lib/error-info.*.json are gone', () => {
    const left = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => /^error-info\..*\.json$/.test(f));
    assert.deepStrictEqual(left, []);
  });

  // Step 1 (d2): the old classes, their shims and the module-facing globals
  // are gone; lib/, bin/ and framework.js name them only in comments (the
  // history in lib/countinghouse-error.js).
  it('names the old classes nowhere in lib/, bin/ or framework.js but comments', () => {
    const left = [];
    for (const f of sources()) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\b(CHError|DeviceError)\b/.test(line) && !/^\s*\/\//.test(line)) {
          left.push(`${path.relative(ROOT, f)}:${i + 1}`);
        }
      });
    }
    assert.deepStrictEqual(left, []);
  });

  it('gives every entry a kind, retryable, httpStatus, mcpCode and its text, in English alone', () => {
    for (const [code, e] of Object.entries(CODES)) {
      assert.ok(/^[A-Z][A-Z0-9_]+$/.test(code), code);
      assert.ok(KINDS.includes(e.kind), `${code}: kind ${e.kind}`);
      assert.strictEqual(typeof(e.retryable), 'boolean', code);
      assert.ok(Number.isInteger(e.httpStatus) && e.httpStatus >= 400 && e.httpStatus <= 599, `${code}: httpStatus ${e.httpStatus}`);
      assert.strictEqual(e.mcpCode, null, code);
      assert.ok(typeof(e.en) === 'string' && e.en.length > 0, `${code}: en`);
      assert.deepStrictEqual(Object.keys(e).sort(), ['en', 'httpStatus', 'kind', 'mcpCode', 'retryable'], code);
    }
  });
});
