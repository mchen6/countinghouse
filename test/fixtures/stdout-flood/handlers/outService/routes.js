// Looks for Node's own stdio streams (they hold its port to the main
// thread) or any MessagePort, by every route the review of #186 named:
// process.stdout/stderr/stdin, console's streams, require('console'), the
// own properties (names and symbols) of process, console and the streams,
// util.inspect of them, and the active handles. Also writes through
// process._rawDebug. Returns what it found; under audit and enforce it must
// find nothing.
const util = require('util');
const NODE_STDIO = /WorkerStdio/;
const isNodeStdio = (v) => v != null && typeof(v) === 'object' && v.constructor != null && NODE_STDIO.test(String(v.constructor.name));
const isPort = (v) => v instanceof MessagePort;

module.exports = async () => {
  const found = [];
  const check = (what, v) => { if (isNodeStdio(v)) found.push(`${what}: a Node stdio stream`); if (isPort(v)) found.push(`${what}: a port`); };
  check('process.stdout', process.stdout);
  check('process.stderr', process.stderr);
  check('process.stdin', process.stdin);
  check('console._stdout', console._stdout);
  check('console._stderr', console._stderr);
  const c = require('console');
  check('require(console)._stdout', c._stdout);
  check('require(console)._stderr', c._stderr);
  const seen = new Set();
  const walk = (o, path, depth) => {
    if (o == null || (typeof(o) !== 'object' && typeof(o) !== 'function') || seen.has(o) || depth > 2) return;
    seen.add(o);
    for (const k of Reflect.ownKeys(o)) {
      let v;
      try {
        const d = Object.getOwnPropertyDescriptor(o, k);
        v = d.get != null ? d.get.call(o) : d.value;
      } catch (e) { continue; }
      const p = `${path}.${String(k)}`;
      check(p, v);
      if (v != null && typeof(v) === 'object') walk(v, p, depth + 1);
    }
  };
  walk(process, 'process', 0);
  walk(console, 'console', 0);
  for (const s of ['stdout', 'stderr', 'stdin']) {
    if (/WorkerStdio|kPort/.test(util.inspect(process[s], {showHidden: true, depth: 1}))) found.push(`util.inspect(process.${s})`);
  }
  if (/WorkerStdio/.test(util.inspect(console, {showHidden: true, depth: 1}))) found.push('util.inspect(console)');
  for (const h of process._getActiveHandles()) check('an active handle', h);
  process._rawDebug('stdout-flood raw \x1b[31mdebug\x1b[0m');
  return {output: {found}};
};
