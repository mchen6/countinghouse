'use strict';
// B-loadopts (after B-golden09) and B-loadopts-2: no test file sets the
// process's options when it is loaded. A folder run (the master walk over
// test/mcp-contract/*.js) requires every file before any test, so options
// set at load reach every other file's tests: mcp-contract 09 saw
// workerThread on from 21's setOptions, red on every master walk for a day.
// A file sets its own in its describe's before() and puts the process's
// back in its after() (test/helpers/options-scope.js).
//
// A parse of each file (espree): the code that runs at load -- the top
// level, every describe/context callback (mocha calls them while it collects
// the tests), a callback a load-time forEach/map calls, a function called at
// once -- never a hook's or a test's body, nor a function only defined. In
// it, a setOptions call, an assignment through the cli-options module (the
// identifiers bound to it, and `options`), or an Object.assign onto it, is an
// offender; so is one in a hook outside every describe (a root hook, run
// around every file of the run).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const espree = require('espree');

// Every test file (B-loadopts-2: all of test/), test/fixtures and scripts/ folders aside (module
// code and scripts mocha never loads). CH_V32_DIR: another directory to scan,
// for a probe of the scan itself.
const DIR = process.env.CH_V32_DIR || path.join(__dirname, '..');
const files = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), {withFileTypes: true}).flatMap((d) => {
  const r = rel === '' ? d.name : `${rel}/${d.name}`;
  if (d.isDirectory()) return (d.name === 'fixtures' || d.name === 'scripts' || d.name === 'node_modules') ? [] : files(dir, r);
  return r.endsWith('.js') ? [r] : [];
});
const HOOKS = new Set(['it', 'specify', 'before', 'after', 'beforeEach', 'afterEach']);
const SUITES = new Set(['describe', 'context']);
const AT_ONCE = new Set(['forEach', 'map', 'flatMap', 'filter', 'some', 'every', 'reduce']);
const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

const isCliOptions = (node) => node != null && node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
  node.callee.name === 'require' && /cli-options/.test(JSON.stringify(node.arguments));
// it / it.skip / describe.only -> its name; arr.forEach -> '.forEach'
function calleeName(c) {
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
    if (c.object.type === 'Identifier' && (SUITES.has(c.object.name) || HOOKS.has(c.object.name))) return c.object.name;
    return `.${c.property.name}`;
  }
  return null;
}
const children = (node) => Object.entries(node).filter(([k]) => k !== 'parent' && k !== 'loc' && k !== 'range')
  .flatMap(([, v]) => (Array.isArray(v) ? v : [v])).filter((v) => v != null && typeof(v.type) === 'string');

// source -> [{line, what}] of the option writes at load
function loadTimeWrites(src) {
  const ast = espree.parse(src, {ecmaVersion: 'latest', sourceType: 'commonjs', loc: true, comment: false});
  // the names the cli-options module is bound to
  const names = new Set(['options']);
  const collect = (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isCliOptions(n.init)) names.add(n.id.name);
    children(n).forEach(collect);
  };
  collect(ast);
  const isOptions = (n) => n != null && ((n.type === 'Identifier' && names.has(n.name)) || isCliOptions(n));
  const base = (m) => { let o = m; while (o.type === 'MemberExpression') o = o.object; return o; };
  const found = [];
  const visit = (node, inSuite) => {
    if (FUNCTION.has(node.type)) return;   // only defined here: run later, if at all
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && isOptions(base(node.left))) {
      found.push({line: node.loc.start.line, what: 'an options field assigned'});
    }
    if (node.type === 'CallExpression') {
      const c = node.callee;
      if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'setOptions') found.push({line: node.loc.start.line, what: 'setOptions'});
      if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.object.name === 'Object' && c.property.name === 'assign' && isOptions(node.arguments[0])) {
        found.push({line: node.loc.start.line, what: 'Object.assign onto the options'});
      }
      const name = calleeName(c);
      // a hook outside every describe runs around every file of the run: its
      // body's writes are the run's, as a load-time one is
      const rootHook = HOOKS.has(name) && !inSuite && name !== 'it' && name !== 'specify';
      // a function called at once runs now
      if (FUNCTION.has(c.type)) visit(c.body, inSuite);
      else visit(c, inSuite);
      for (const a of node.arguments) {
        if (!FUNCTION.has(a.type)) { visit(a, inSuite); continue; }
        if (SUITES.has(name)) visit(a.body, true);
        else if (rootHook) visit(a.body, false);
        else if (name != null && name.startsWith('.') && AT_ONCE.has(name.slice(1))) visit(a.body, inSuite);
      }
      return;
    }
    children(node).forEach((ch) => visit(ch, inSuite));
  };
  visit(ast, false);
  return found;
}

describe('validation 32: no test file sets the options at load (B-loadopts, B-loadopts-2)', function() {
  this.timeout(60000);   // (a parse of every test file)
  it('no code a test file runs at load (its top level, its describe bodies, a root hook) writes the options', () => {
    const offenders = [];
    for (const f of files(DIR).sort()) {
      for (const w of loadTimeWrites(fs.readFileSync(path.join(DIR, f), 'utf8'))) offenders.push(`${f}:${w.line}: ${w.what}`);
    }
    assert.deepStrictEqual(offenders, []);
  });

  it('the scan sees each form at load, in a describe body too, and none in a hook, a test or a function only defined', () => {
    const at = (src) => loadTimeWrites(src).map((w) => w.what);
    assert.deepStrictEqual(at("const o = require('../../lib/cli-options');\no.setOptions({a: 1});\n"), ['setOptions']);
    assert.deepStrictEqual(at("require('../../lib/cli-options').setOptions({a: 1});\n"), ['setOptions']);
    assert.deepStrictEqual(at("const opts = require(path.join(ROOT, 'lib', 'cli-options'));\nopts.workerThread = true;\n"), ['an options field assigned']);
    assert.deepStrictEqual(at("Object.assign(options, {workerThread: true});\n"), ['Object.assign onto the options']);
    assert.deepStrictEqual(at("describe('d', () => {\n  options.setOptions({});\n});\n"), ['setOptions']);
    assert.deepStrictEqual(at("[1, 2].forEach((n) => describe(`d${n}`, () => { options.debug = true; }));\n"), ['an options field assigned']);
    assert.deepStrictEqual(at("if (process.env.CI) { options.setOptions({}); }\n"), ['setOptions']);
    assert.deepStrictEqual(at("before(() => { options.setOptions({}); });\n"), ['setOptions']);
    assert.deepStrictEqual(at("after(() => { fs.rmSync(dir); });\n"), []);
    // never: a hook's or a test's body, a function only defined, a string or a comment
    assert.deepStrictEqual(at([
      "const url = 'https://example.com/{x}/*';",
      "// options.setOptions({})",
      "const s = \"options.setOptions(x) } {\";",
      "const later = () => { options.setOptions({}); };",
      "function setUp() { options.workerThread = false; }",
      "describe('d', () => {",
      "  before(() => { options.setOptions({}); });",
      "  it('t', () => { options.debug = true; Object.assign(options, {}); });",
      "  after(() => { later(); setUp(); });",
      "});"
    ].join('\n')), []);
  });
});
