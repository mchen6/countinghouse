#!/usr/bin/env node
'use strict';
// Maps every server port in the server tests (those built on
// test/helpers/sandbox-server.js, and since #192 those that spawn framework.js
// or pass --port themselves) with testPort (test/helpers/test-env.js), so that each honours
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
// A server test: one built on sandbox-server, or one that starts a server
// itself (#192): its code (not a comment) names 'framework.js' or passes a
// '--port' argument. Validation 14 scans the same files. Validation 14 itself
// is not one: its numbers are testPort's probes.
// (or, in a shell command line, `--port N` with N a test port: test1, 2, 8)
const SPAWNS_SERVER = /['"`/]framework\.js['"`]|['"`]--port(['"`]|=)|--port[= ]9[5-9]\d\d\b/;
const NOT_SERVER_TESTS = new Set(['test/validation/14-test-ports.js']);
const codeText = (text) => text.split('\n').map((l) => split(l)[0]).join('\n');
const isServerTest = (text, rel) => !NOT_SERVER_TESTS.has(rel) && (USES_HELPER.test(text) || SPAWNS_SERVER.test(codeText(text)));
// The test ports: test/ports.md's range, 9500-9999.
const PORT = '9[5-9]\\d\\d';

// Every test file under test/, but its fixtures and helpers (test1.js to
// test8.js at test/'s top pass --port 9527 since #215).
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

// A port in text: not part of a longer number or name.
const portIn = () => new RegExp(`(?<![\\w.$])(${PORT})(?!\\d)`, 'g');

// Code (no strings in it): a bare port becomes testPort(N), unless it is
// already one's argument.
function mapCode(code, keep) {
  return code.replace(portIn(), (all, n, off, s) => {
    if (keep.has(n) || /testPort\(\s*$/.test(s.slice(Math.max(0, off - 12), off))) return all;
    return `testPort(${n})`;
  });
}

// A '...' or "..." string's text with a port: a template that holds
// ${testPort(N)}; the whole string a port: String(testPort(N)).
function mapQuoted(quote, inner, keep) {
  const ports = [...inner.matchAll(portIn())].filter((m) => !keep.has(m[1]));
  if (ports.length === 0) return null;
  if (portIn().test(inner) && inner === ports[0][1]) return `String(testPort(${inner}))`;
  const text = inner.replace(/\\(['"])/g, '$1').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return '`' + text.replace(portIn(), (all, n) => (keep.has(n) ? all : `\${testPort(${n})}`)) + '`';
}

// One line of code, string-aware: code, '...' and "..." strings, and
// templates (their text, and the code in each ${...}). Regex literals are
// not parsed; a line with one is mapped as code around it.
function mapLine(code, keep) {
  let out = '';
  let i = 0;
  let plain = '';
  const flush = () => { out += mapCode(plain, keep); plain = ''; };
  while (i < code.length) {
    const c = code[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) j += (code[j] === '\\') ? 2 : 1;
      const inner = code.slice(i + 1, j);
      const mapped = mapQuoted(c, inner, keep);
      flush();
      if (mapped == null) out += code.slice(i, j + 1);
      else {
        // an object key: computed
        const before = out.replace(/\s+$/, '').slice(-1);
        const after = code.slice(j + 1).replace(/^\s+/, '')[0];
        out += (after === ':' && (before === '{' || before === ',') && mapped.startsWith('`')) ? `[${mapped}]` : mapped;
      }
      i = j + 1;
      continue;
    }
    if (c === '`') {
      flush();
      let j = i + 1;
      let text = '';
      out += '`';
      while (j < code.length && code[j] !== '`') {
        if (code[j] === '\\') { text += code.slice(j, j + 2); j += 2; continue; }
        if (code[j] === '$' && code[j + 1] === '{') {
          out += text.replace(portIn(), (all, n) => (keep.has(n) ? all : `\${testPort(${n})}`));
          text = '';
          let depth = 1;
          let k = j + 2;
          while (k < code.length && depth > 0) { if (code[k] === '{') depth++; else if (code[k] === '}') depth--; if (depth > 0) k++; }
          // a ${ the line leaves open (the template goes on): no } added
          out += '${' + mapLine(code.slice(j + 2, k), keep) + (k < code.length ? '}' : '');
          j = k + 1;
          continue;
        }
        text += code[j];
        j++;
      }
      out += text.replace(portIn(), (all, n) => (keep.has(n) ? all : `\${testPort(${n})}`));
      if (j < code.length) out += '`';
      i = j + 1;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
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
  // testPort's require at the top level, beside the file's top-level
  // sandbox-server require (a helper required inside a describe is in that
  // scope only, and the ports may be used outside it); without one, after
  // the last top-level line that is a require itself (`x = require(...)`),
  // never after one that merely calls require inside a value, which may come
  // after the ports' first use
  if (changes.length > 0 && !/^const \{[^}]*\btestPort\b[^}]*\}\s*=\s*require\(/m.test(text)) {
    const all = text.split('\n');
    // never below the first use (a temporal dead zone at load): beside the
    // sandbox-server require when that comes first, else after the last
    // top-level require above the first use, else just above it
    const firstUse = all.findIndex((l) => /\btestPort\(/.test(split(l)[0]));
    let last = all.findIndex((l) => /^(const|let|var) /.test(l) && USES_HELPER.test(l));
    if (last < 0 || last >= firstUse) {
      last = -1;
      all.forEach((l, i) => { if (i < firstUse && /^(const|let|var) [^=]+=\s*require\(/.test(l)) last = i; });
      if (last < 0) last = firstUse - 1;
    }
    if (last < 0) throw new Error(`${rel}: no top-level require to put testPort's after`);
    // test-env, relative to this file (test/'s top-level files are one up)
    let helper = path.relative(path.dirname(file), path.join(ROOT, 'test', 'helpers', 'test-env')).split(path.sep).join('/');
    if (!helper.startsWith('.')) helper = `./${helper}`;
    all.splice(last + 1, 0, `const {testPort} = require('${helper}');`);
    text = all.join('\n');
  }
  return {rel, text, changes};
}

function main(argv) {
  const check = argv.includes('--check');
  let total = 0;
  for (const file of testFiles(path.join(ROOT, 'test'))) {
    if (!isServerTest(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file).split(path.sep).join('/'))) continue;
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

module.exports = {mapLine, split, isServerTest, PORT, testFiles};
