#!/usr/bin/env node
'use strict';
// Maps every server port in the tests built on test/helpers/sandbox-server.js
// with testPort (test/helpers/test-env.js), so that each honours
// CH_TEST_PORT_BASE under test/helpers/run-local.js. A port is a 4-digit
// 9600-9799 literal in a line's code (never a comment). It becomes:
//   - a number:             9749            -> testPort(9749)
//   - a whole string:       '9749'          -> String(testPort(9749))
//   - in a string:          'host:9749'     -> `host:${testPort(9749)}`
//   - in a template's text: `...:9749...`   -> `...:${testPort(9749)}...`
// A port already in testPort(...) is left, so a second run changes nothing,
// and so is a port a fixture declares in its own files (FIXTURE_PORTS).
// The file gets testPort from test-env beside its sandbox-server require.
// validation 14 fails on any port this leaves unmapped.
//
//   node scripts/map-test-ports.js           rewrite the files
//   node scripts/map-test-ports.js --check   print what it would change; exit 1 if anything
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// test/fixtures/remote-probe/package.json declares http://127.0.0.1:9688
const FIXTURE_PORTS = {'test/remote/05-route.js': new Set(['9688'])};
const USES_HELPER = /require\(['"]\.\.\/helpers\/sandbox-server['"]\)/;

function testFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return (e.name === 'fixtures' || e.name === 'helpers') ? [] : testFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

// [code, comment]: a whole-line comment is all comment; else the code ends
// at a // that starts a comment (not a URL's ://, not inside a string).
function split(line) {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return ['', line];
  const m = /(^|[^:'"`])\/\/(?![^'"`]*['"`]\s*[,)\]};])/.exec(line);
  const cut = (m != null) ? m.index + m[1].length : line.length;
  return [line.slice(0, cut), line.slice(cut)];
}

function mapLine(code, keep) {
  let out = code;
  out = out.replace(/(['"])(9[67]\d\d)\1/g, (all, q, n) => (keep.has(n) ? all : `String(testPort(${n}))`));
  out = out.replace(/'([^'\n]*?:)(9[67]\d\d)([^'\n]*)'/g, (all, a, n, b) => (keep.has(n) || a.includes('`') || b.includes('`') ? all : `\`${a}\${testPort(${n})}${b}\``));
  out = out.replace(/(`[^`]*?)(:)(9[67]\d\d)(?=[^`]*`)/g, (all, pre, c, n) => (keep.has(n) ? all : `${pre}${c}\${testPort(${n})}`));
  out = out.replace(/(^|[^\w.$])(9[67]\d\d)\b/g, (all, p, n, off, s) => {
    if (keep.has(n)) return all;
    if (/testPort\($/.test(s.slice(Math.max(0, off - 9), off + p.length))) return all;
    return `${p}testPort(${n})`;
  });
  return out;
}

function mapFile(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const keep = FIXTURE_PORTS[rel] || new Set();
  const changes = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((line, i) => {
    const [code, comment] = split(line);
    const mapped = mapLine(code, keep);
    if (mapped !== code) changes.push({line: i + 1, before: code.trim(), after: mapped.trim()});
    return mapped + comment;
  });
  let text = lines.join('\n');
  // testPort's require at the top level, after the file's last top-level
  // require: a helper required inside a describe is in that scope only, and
  // the ports may be used outside it
  if (changes.length > 0 && !/^const \{[^}]*\btestPort\b[^}]*\}\s*=\s*require\(/m.test(text)) {
    const all = text.split('\n');
    let last = -1;
    all.forEach((l, i) => { if (/^(const|let|var) .*require\(/.test(l)) last = i; });
    if (last < 0) throw new Error(`${rel}: no top-level require to put testPort's after`);
    all.splice(last + 1, 0, "const {testPort} = require('../helpers/test-env');");
    text = all.join('\n');
  }
  return {rel, text, changes};
}

function main(argv) {
  const check = argv.includes('--check');
  let total = 0;
  for (const file of testFiles(path.join(ROOT, 'test'))) {
    if (!USES_HELPER.test(fs.readFileSync(file, 'utf8'))) continue;
    const {rel, text, changes} = mapFile(file);
    if (changes.length === 0) continue;
    total += changes.length;
    if (check) for (const c of changes) process.stdout.write(`${rel}:${c.line}\n  - ${c.before}\n  + ${c.after}\n`);
    else fs.writeFileSync(file, text);
  }
  process.stdout.write(`${check ? 'would change' : 'changed'} ${total} line(s)\n`);
  return (check && total > 0) ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {mapLine, split};
