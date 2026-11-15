// Every server test (built on test/helpers/sandbox-server.js, or, since #192,
// one that spawns framework.js or passes --port itself) honours
// CH_TEST_PORT_BASE (test/helpers/run-local.js): it maps every port it uses
// with testPort, once, by its default, so its server, its URLs, its Host
// headers and any --port agree. The helpers take ports as given. A test file
// with a server port (9500-9999, test/ports.md's range) left as a literal is
// named here. The one
// exception is a port a fixture declares in its own files.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
// the same files the rewrite maps (scripts/map-test-ports.js)
const {isServerTest, PORT, testFiles} = require('../../scripts/map-test-ports');

const ROOT = path.join(__dirname, '..', '..');
// test/fixtures/remote-probe/package.json declares http://127.0.0.1:9688
const FIXTURE_PORTS = {'test/remote/05-route.js': ['9688']};


// The code of a line: without a whole-line comment or a trailing // comment.
const codeOf = (line) => {
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return '';
  const m = /(^|[^:'"`])\/\/(?![^'"`]*['"`]\s*[,)\]};])/.exec(line);
  return (m != null) ? line.slice(0, m.index + m[1].length) : line;
};

describe('validation 14: server tests\' ports honour CH_TEST_PORT_BASE', () => {
  it('every server port in a server test (sandbox-server, or one that spawns framework.js or passes --port) is mapped with testPort', () => {
    const unmapped = [];
    for (const file of testFiles(path.join(ROOT, 'test'))) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (!isServerTest(text, rel)) continue;
      const allowed = new Set(FIXTURE_PORTS[rel] || []);
      text.split('\n').forEach((line, i) => {
        // what is left once every testPort(N) is taken out
        const left = codeOf(line).replace(new RegExp(`testPort\\(\\s*${PORT}\\s*\\)`, 'g'), '');
        for (const m of left.matchAll(new RegExp(`(^|[^\\w.$])(${PORT})\\b`, 'g'))) {
          if (!allowed.has(m[2])) unmapped.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    assert.deepStrictEqual(unmapped, []);
  });

  // The base is read when test-env loads, so each case runs in a child.
  const probe = (env, defaults) => JSON.parse(execFileSync(process.execPath, ['-e', `
    const {testPort} = require('./test/helpers/test-env');
    console.log(JSON.stringify(${JSON.stringify(defaults)}.map((d) => testPort(d)).concat([testPort(${defaults[0]})])));
  `], {cwd: ROOT, env: Object.assign({}, process.env, env), encoding: 'utf8'}));

  it('with a base: each default gets the next port, the same each time it is asked, and never the private Redis\'s', () => {
    const ten = [9661, 9662, 9663, 9664, 9665, 9666, 9667, 9668, 9669, 9670];
    assert.deepStrictEqual(probe({CH_TEST_PORT_BASE: '9740', CH_TEST_REDIS_URL: 'redis://127.0.0.1:9749'}, ten),
      [9740, 9741, 9742, 9743, 9744, 9745, 9746, 9747, 9748, 9750, 9740]);
  });

  it('without one (CI): every port is the test\'s own', () => {
    assert.deepStrictEqual(probe({CH_TEST_PORT_BASE: '', CH_TEST_REDIS_URL: ''}, [9749, 9688]), [9749, 9688, 9749]);
  });

  // #192: under a base, no server a test spawns listens outside the block.
  // The guard (test/helpers/port-guard.js, loaded for every mocha run) refuses
  // a spawn whose --port is a test port testPort did not hand out.
  const guarded = (env, body) => execFileSync(process.execPath, ['-e', `
    require('./test/helpers/port-guard');
    const {testPort} = require('./test/helpers/test-env');
    const cp = require('child_process');
    const tryIt = (f) => { try { f(); return 'ran'; } catch (e) { return /port guard/.test(e.message) ? 'refused' : 'error: ' + e.message; } };
    console.log(JSON.stringify(${body}));
  `], {cwd: ROOT, env: Object.assign({}, process.env, env), encoding: 'utf8'});
  const cases = `[
    tryIt(() => cp.spawnSync(process.execPath, ['-e', '0', '--port', '9625'])),
    tryIt(() => cp.spawnSync(process.execPath, ['-e', '0', '--port=9626'])),
    tryIt(() => cp.execSync('node -e 0 -- --port 9627')),
    tryIt(() => cp.spawnSync(process.execPath, ['-e', '0', '--port', String(testPort(9625))])),
    tryIt(() => cp.spawnSync(process.execPath, ['-e', '0', '--port', '41234'])),
    tryIt(() => cp.spawnSync(process.execPath, ['-e', '0']))
  ]`;

  it('(#192) with a base: a spawn with an unmapped test --port is refused, in each form; a mapped, an OS-assigned or no port runs', () => {
    assert.deepStrictEqual(JSON.parse(guarded({CH_TEST_PORT_BASE: '9740', CH_TEST_REDIS_URL: 'redis://127.0.0.1:9749'}, cases)),
      ['refused', 'refused', 'refused', 'ran', 'ran', 'ran']);
  });

  it('(#192) without a base (CI): the guard does nothing', () => {
    assert.deepStrictEqual(JSON.parse(guarded({CH_TEST_PORT_BASE: '', CH_TEST_REDIS_URL: ''}, cases)), ['ran', 'ran', 'ran', 'ran', 'ran', 'ran']);
  });
});
