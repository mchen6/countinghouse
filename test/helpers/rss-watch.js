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
// then the stacks, each bounded in time, and SIGKILL. It ends with the
// watched process. The diagnostic report on SIGUSR2 never came (#346's
// first hit: its handler needs the main loop, which was the busy one), so:
// - JS stacks, from the inspector: SIGUSR1 starts it on its own thread even
//   with the main thread busy; /json/list gives its websocket (port 9229);
//   Debugger.pause on the main isolate, and on each worker's through
//   NodeWorker, prints the paused call frames (function, url:line:column).
//   A pause stops the main thread's JS, and so its allocation, if JS it is.
// - native stacks, from gdb (sudo -n where there is one: CI's runners),
//   for the busiest threads: whether a thread is in JS, a GC or a copy.
// And machine-wide (the runner's memory, which a loss's monitor showed at
// 11.7 GB used): while /proc/meminfo's MemAvailable is under 4 GB it prints,
// at most once per 2 s, the 8 processes with the most RSS (pid, ppid, RSS,
// command line cut to 120), killing nothing: only the watched process, past
// its own limit, is killed.
// Linux only (CI); elsewhere it exits at once.
const fs = require('fs');
const {spawnSync} = require('child_process');

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

const say = (line) => process.stdout.write(`[ml24-watch] ${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frameText = (f) => `${f.functionName || '(anonymous)'} ${String(f.url || '').replace(/^file:\/\//, '')}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`;

// The JS stacks of the main isolate and of each worker, paused through the
// inspector, within budgetMs.
async function jsStacks(budgetMs) {
  const until = Date.now() + budgetMs;
  if (typeof(WebSocket) !== 'function' || typeof(fetch) !== 'function') return say('no WebSocket or fetch in this Node: no JS stacks');
  try { process.kill(pid, 'SIGUSR1'); } catch (e) { return say('the test process is gone: no JS stacks'); }
  let target = null;
  while (target == null && Date.now() < until) {
    try {
      const list = await (await fetch('http://127.0.0.1:9229/json/list')).json();
      target = list.find((t) => typeof(t.webSocketDebuggerUrl) === 'string') || null;
    } catch (e) { await sleep(200); }
  }
  if (target == null) return say('the inspector did not answer on 127.0.0.1:9229: no JS stacks');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const send = (method, params = {}) => ws.send(JSON.stringify({id: nextId++, method, params}));
  const toWorker = (sessionId, method, params = {}) => send('NodeWorker.sendMessageToWorker', {sessionId, message: JSON.stringify({id: nextId++, method, params})});
  const titles = new Map();
  const told = new Set();
  const paused = (who, frames) => {
    if (told.has(who)) return;
    told.add(who);
    say(`JS stack of ${who} (${frames.length} frames, innermost first):`);
    for (const f of frames.slice(0, 25)) say(`    ${frameText(f)}`);
  };
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(String(ev.data)); } catch (e) { return; }
    if (m.method === 'Debugger.paused') return paused('the main thread', m.params.callFrames || []);
    if (m.method === 'NodeWorker.attachedToWorker') {
      const sid = m.params.sessionId;
      titles.set(sid, `worker ${m.params.workerInfo ? `${m.params.workerInfo.workerId} ${m.params.workerInfo.url || ''}` : sid}`);
      toWorker(sid, 'Debugger.enable');
      toWorker(sid, 'Debugger.pause');
      return;
    }
    if (m.method === 'NodeWorker.receivedMessageFromWorker') {
      let inner;
      try { inner = JSON.parse(m.params.message); } catch (e) { return; }
      if (inner.method === 'Debugger.paused') paused(titles.get(m.params.sessionId) || 'a worker', inner.params.callFrames || []);
    }
  });
  await new Promise((resolve) => { ws.addEventListener('open', resolve, {once: true}); ws.addEventListener('error', resolve, {once: true}); setTimeout(resolve, Math.max(0, until - Date.now())); });
  if (ws.readyState !== 1) return say('the inspector\'s websocket did not open: no JS stacks');
  send('Debugger.enable');
  send('Debugger.pause');
  send('NodeWorker.enable', {waitForDebuggerOnStart: false});
  while (Date.now() < until && !(told.has('the main thread') && told.size > titles.size)) await sleep(100);
  if (!told.has('the main thread')) say('the main thread did not pause in time: it is not running JS (native code: a GC, a copy, a lock?)');
  try { ws.close(); } catch (e) { /* gone */ }
}

// The native stacks of the busiest threads, from gdb, within budgetMs. The
// process stays stopped under gdb only while it reads them.
function nativeStacks(busyTids, budgetMs) {
  const args = ['-batch', '-p', String(pid), '-ex', 'set pagination off', '-ex', 'thread apply all bt 30'];
  let r = spawnSync('sudo', ['-n', 'gdb'].concat(args), {encoding: 'utf8', timeout: budgetMs});
  if (r.error != null || !/Thread /.test(r.stdout || '')) r = spawnSync('gdb', args, {encoding: 'utf8', timeout: budgetMs});
  if (r.error != null || !/Thread /.test(r.stdout || '')) return say(`no native stacks (gdb: ${r.error != null ? r.error.code || r.error.message : String(r.stderr || '').trim().split('\n').pop()})`);
  const blocks = r.stdout.split(/\n(?=Thread \d+ )/);
  for (const b of blocks) {
    const lwp = (/\(LWP (\d+)\)/.exec(b) || [])[1];
    if (lwp == null || !busyTids.has(lwp)) continue;
    say(`native stack of thread ${lwp}:`);
    for (const line of b.split('\n').slice(0, 32)) say(`    ${line}`);
  }
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
    // the busiest (at least half a CPU in the last 250 ms) and the main thread
    const busy = new Set(rows.filter((r) => r.used >= 12).map((r) => r.tid).concat([String(pid)]));
    const kill = () => {
      say('killing the test process (SIGKILL)');
      try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ }
      process.exit(0);
    };
    // a backstop: whatever the stacks do, the process is killed in 30 s
    setTimeout(kill, 30000).unref();
    jsStacks(8000).catch((e) => say(`JS stacks failed: ${e.message}`))
      .then(() => nativeStacks(busy, 15000))
      .catch((e) => say(`native stacks failed: ${e.message}`))
      .then(kill);
  }
  last = now;
}, 250);
