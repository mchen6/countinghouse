'use strict';
// TEMPORARY INSTRUMENTATION for #344: remove once its cause is fixed.
//
// A watchdog OUTSIDE the watched process: node test/helpers/rss-watch.js
// <pid> <limit bytes> <case file>. module-loading 24's in-process watchdog
// (a 250 ms timer) never fired during the growth that loses CI's runner: the
// main thread ran no timers, so whatever grows the process also blocks it.
// This one is its own process. Every 250 ms it reads /proc/<pid>/status and
// each thread's /proc/<pid>/task/<tid>/stat. Once VmRSS passes the limit it
// prints, once:
// - the case the test file was in (its last line written to <case file>);
// - VmRSS and VmHWM;
// - every thread with its name, its state and the CPU ticks it used since
//   the last sample, busiest first;
// then sends SIGUSR2 (the test file set process.report to write a
// diagnostic report to stdout on it: native stacks, heap statistics, libuv
// handles) and, 3 s later, SIGKILL. It ends with the watched process.
// And machine-wide (the runner's memory, which a loss's monitor showed at
// 11.7 GB used): while /proc/meminfo's MemAvailable is under 4 GB it prints,
// at most once per 2 s, the 8 processes with the most RSS (pid, ppid, RSS,
// command line cut to 120), killing nothing: only the watched process, past
// its own limit, is killed.
// Linux only (CI); elsewhere it exits at once.
const fs = require('fs');

const [pidArg, limitArg, caseFile] = process.argv.slice(2);
const pid = Number(pidArg);
const limit = Number(limitArg);
if (process.platform !== 'linux' || !Number.isInteger(pid) || !(limit > 0)) process.exit(0);

const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const kib = (field, text) => { const m = new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(text); return m == null ? null : Number(m[1]) * 1024; };
const mb = (b) => (b == null ? '?' : `${Math.round(b / (1024 * 1024))}MB`);

// tid -> {name, state, ticks}; the name is in parentheses and may hold spaces
function threads() {
  const out = new Map();
  let tids = [];
  try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch (e) { return out; }
  for (const tid of tids) {
    let stat;
    try { stat = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8'); } catch (e) { continue; }
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    const rest = stat.slice(close + 2).split(' ');
    // after the name: state, then field 14 (utime) and 15 (stime) of stat(5) are rest[11] and rest[12]
    out.set(tid, {name: stat.slice(open + 1, close), state: rest[0], ticks: Number(rest[11]) + Number(rest[12])});
  }
  return out;
}

// a closed stdout (its reader gone) never ends the watcher
process.stdout.on('error', () => {});

const LOW_AVAILABLE = 4 * 1024 * 1024 * 1024;
const TOP_EVERY_MS = 2000;
let toldTopAt = 0;

// the `n` processes with the most RSS, as one line each
function topByRss(n) {
  const rows = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch (e) { return rows; }
  for (const p of pids) {
    try {
      const st = fs.readFileSync(`/proc/${p}/status`, 'utf8');
      const rss = kib('VmRSS', st);
      if (rss == null) continue;
      const ppid = (/^PPid:\s+(\d+)/m.exec(st) || [])[1];
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch (e) { /* gone */ }
      rows.push({pid: p, ppid, rss, cmd: cmd.slice(0, 120)});
    } catch (e) { /* gone meanwhile */ }
  }
  return rows.sort((a, b) => b.rss - a.rss).slice(0, n);
}

function machineCheck() {
  let info = '';
  try { info = fs.readFileSync('/proc/meminfo', 'utf8'); } catch (e) { return; }
  const available = kib('MemAvailable', info);
  if (available == null || available >= LOW_AVAILABLE || Date.now() - toldTopAt < TOP_EVERY_MS) return;
  toldTopAt = Date.now();
  const rows = topByRss(8).map((r) => `${r.pid} (ppid ${r.ppid}) ${mb(r.rss)} ${r.cmd}`);
  process.stdout.write(`\n[ml24-watch] MemAvailable ${mb(available)} (under ${mb(LOW_AVAILABLE)}); watched pid ${pid}; top by RSS: ${rows.join(' | ')}\n`);
}

let last = threads();
let fired = false;
const timer = setInterval(() => {
  if (!alive()) { clearInterval(timer); return; }
  machineCheck();
  if (fired) return;
  let status = '';
  try { status = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); } catch (e) { return; }
  const now = threads();
  const rss = kib('VmRSS', status);
  if (rss != null && rss > limit) {
    fired = true;
    let where = '(unknown)';
    try { where = fs.readFileSync(caseFile, 'utf8').trim().split('\n').pop(); } catch (e) { /* none written */ }
    const rows = [...now].map(([tid, t]) => ({tid, name: t.name, state: t.state, used: t.ticks - (last.has(tid) ? last.get(tid).ticks : t.ticks)}))
      .sort((a, b) => b.used - a.used);
    process.stdout.write(`\n[ml24-watch] RSS ${mb(rss)} (peak ${mb(kib('VmHWM', status))}) over ${mb(limit)} during "${where}"; ${rows.length} threads, busiest first ` +
      `(ticks in the last 250 ms): ${rows.slice(0, 24).map((r) => `${r.tid} ${r.name} ${r.state} ${r.used}`).join(' | ')}\n`);
    try { process.kill(pid, 'SIGUSR2'); } catch (e) { /* gone */ }
    setTimeout(() => {
      process.stdout.write('[ml24-watch] killing the test process (SIGKILL)\n');
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ }
      process.exit(0);
    }, 3000);
  }
  last = now;
}, 250);
