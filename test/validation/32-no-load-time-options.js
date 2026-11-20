'use strict';
// B-loadopts (after B-golden09): no file of test/mcp-contract sets the
// process's options when it is loaded. A folder run (the master walk over
// test/mcp-contract/*.js) requires every file before any test, so options
// set at load reach every other file's tests: mcp-contract 09 saw
// workerThread on from 21's setOptions, red on every master walk for a day.
// A file sets its own in its describe's before() and puts the process's
// back in its after() (test/helpers/options-scope.js). A static scan: a
// setOptions call, or an options field assigned, outside every function.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'mcp-contract');

// the statements at the file's top level (outside every function body): its
// text with each {...} that follows "=>" or a function's ")" blanked out
function topLevel(src) {
  const out = src.split('');
  // strings, template literals and comments are blanked first, so a brace in
  // one is never counted
  const blank = (from, to) => { for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' '; };
  for (const re of [/\/\*[\s\S]*?\*\//g, /\/\/[^\n]*/g, /`(?:\\[\s\S]|[^`\\])*`/g, /'(?:\\.|[^'\\\n])*'/g, /"(?:\\.|[^"\\\n])*"/g]) {
    let m;
    const text = out.join('');
    while ((m = re.exec(text)) != null) blank(m.index, m.index + m[0].length);
  }
  const text = out.join('');
  let depth = 0;
  const kept = text.split('');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    if (depth > 0 && kept[i] !== '\n') kept[i] = ' ';
    if (text[i] === '}') depth -= 1;
  }
  return kept.join('');
}

describe('validation 32: no mcp-contract file sets the options at load (B-loadopts)', () => {
  it('every setOptions call and every options.<field> = in test/mcp-contract is inside a function (a hook or a test)', () => {
    const offenders = [];
    for (const f of fs.readdirSync(DIR).filter((n) => n.endsWith('.js')).sort()) {
      const lines = topLevel(fs.readFileSync(path.join(DIR, f), 'utf8')).split('\n');
      lines.forEach((l, i) => {
        if (/\.setOptions\s*\(|\boptions\.\w+\s*=[^=]/.test(l)) offenders.push(`${f}:${i + 1}: ${l.trim()}`);
      });
    }
    assert.deepStrictEqual(offenders, []);
  });

  it('the scan sees a top-level call, and passes one in a hook', () => {
    assert.match(topLevel("const o = require('x');\no.setOptions({a: 1});\n"), /setOptions\(/);
    assert.doesNotMatch(topLevel("describe('d', () => {\n  before(() => { o.setOptions({a: 1}); });\n});\n"), /setOptions\(/);
    assert.doesNotMatch(topLevel("// options.setOptions({})\nconst s = 'options.setOptions(x)';\n"), /setOptions\(/);
  });
});
