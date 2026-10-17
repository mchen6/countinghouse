// Quick pre-check: lists obvious test server starts that pass neither
// --workerThread nor --no-workerThread, and in-process setOptions calls that
// do not set workerThread. The runtime guard (test/helpers/require-thread-
// flag.js) is the proof; this only saves a 35-minute run.
//   node test/helpers/thread-flag-check.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// A spawn site: a child-process call naming framework.js or the countinghouse
// launcher (not the other bin/countinghouse-* tools), on this line or the
// next two. Calls to the shared helper's startServer(port, args) count too,
// in files that import it; a file's own startServer helper is checked at its
// spawn line instead.
const SPAWN = /\b(spawn|exec|execFile|execFileSync|fork)\(/;
const TARGET = /framework\.js|bin['"\/, ]+countinghouse(?![-\w])/;
const HELPER_CALL = /\bstartServer\(/;
const FLAG = /--(no-)?workerThread/;
const SET_OPTIONS = /setOptions\((\{[^)]*\}|minimist\()/;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (name === 'node_modules' || name === 'unit') continue;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js') && p !== __filename && !p.endsWith(path.join('helpers', 'sandbox-server.js'))) out.push(p);
  }
  return out;
}

const misses = [];
for (const file of walk(ROOT, [])) {
  const text = fs.readFileSync(file, 'utf8');
  const usesHelper = /helpers\/sandbox-server/.test(text);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;   // comments
    if (line.includes('thread-flag-check: default on purpose') ||
        (i > 0 && lines[i - 1].includes('thread-flag-check: default on purpose'))) return;
    // a spawn's argument list may run on for several lines
    const window = lines.slice(i, i + 10).join(' ');
    const isSpawn = SPAWN.test(line) && TARGET.test(window) && !/pkill/.test(line);
    const isHelperCall = usesHelper && HELPER_CALL.test(line) && !/function startServer/.test(line);
    if ((isSpawn || isHelperCall) && !FLAG.test(window)) misses.push(`${path.relative(ROOT, file)}:${i + 1} server start`);
    if (SET_OPTIONS.test(line) && !/workerThread/.test(window)) misses.push(`${path.relative(ROOT, file)}:${i + 1} setOptions`);
  });
}
misses.forEach((m) => console.log(m));
process.exit(misses.length > 0 ? 1 : 0);
