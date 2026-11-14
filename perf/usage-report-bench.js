#!/usr/bin/env node
'use strict';
// countinghouse_usage_report over a large usage directory: the time and the
// memory one report costs, for an admin (every caller) and a plain caller
// (its own calls). Each case runs in a child process of its own, so its heap
// and peak RSS are its own.
//
//   node perf/usage-report-bench.js [records=200000]
//
// The fixture: `records` usage records (each tool call one result and two
// server calls) spread over 60 days and 10 callers, in the layout the
// runtime writes (<dir>/<day>/<pid>-<startMs>.jsonl), in a temporary
// directory removed at the end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const DAY = 86400000;
const CALLERS = 10;
const DAYS = 60;

function writeFixture(dir, records) {
  const calls = Math.ceil(records / 3);
  const perDay = Math.ceil(calls / DAYS);
  let call = 0;
  for (let d = 0; d < DAYS && call < calls; d++) {
    const dayStart = NOW - (DAYS - d) * DAY;
    const day = new Date(dayStart).toISOString().slice(0, 10);
    fs.mkdirSync(path.join(dir, day), {recursive: true});
    const lines = [];
    for (let i = 0; i < perDay && call < calls; i++, call++) {
      const t = (k) => new Date(dayStart + i * 1000 + k).toISOString();
      const caller = `u_${String(call % CALLERS).padStart(8, '0')}`;
      lines.push(JSON.stringify({t: t(0), call, server: 'github', module: 'ch-access-github', tool: 'get_job_logs', bytesIn: 4000, linesIn: 40, ms: 120, outcome: 'ok', credential: 'GITHUB_TOKEN', caller}));
      lines.push(JSON.stringify({t: t(1), call, server: 'github', module: 'ch-access-github', tool: 'actions_list', bytesIn: 2000, linesIn: 20, ms: 80, outcome: 'ok', credential: 'GITHUB_TOKEN', caller}));
      lines.push(JSON.stringify({t: t(2), call, pack: 'ch-pack-ci-failure-triage', module: 'ch-pack-ci-failure-triage', tool: 'ci_failure_triage', bytesOut: 600, linesOut: 6, ms: 900, outcome: 'ok', caller}));
    }
    fs.writeFileSync(path.join(dir, day, `${1000 + d}-${dayStart}.jsonl`), `${lines.join('\n')}\n`);
  }
  return call * 3;
}

// One case, in this child process: the report's wall time, the heap after
// it, and the process's peak RSS.
async function runCase(dir, who) {
  const {usageReport} = require('../lib/usage/report');
  const caller = who === 'admin' ? {caller: 'u_admin', isAdmin: true} : {caller: 'u_00000003', isAdmin: false};
  const t0 = process.hrtime.bigint();
  const out = await Promise.resolve(usageReport(who === 'plain-all' ? {since: 'all'} : {}, caller, {usage: null, usageDir: dir, now: () => NOW}));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const heapMb = process.memoryUsage().heapUsed / 1048576;
  const rssMb = process.resourceUsage().maxRSS / 1024;
  process.stdout.write(JSON.stringify({who, ms: Math.round(ms), heapMb: Math.round(heapMb), peakRssMb: Math.round(rssMb), calls: out.totals.calls, serverCalls: out.totals.serverCalls}));
}

async function main() {
  if (process.argv[2] === '--case') return runCase(process.argv[3], process.argv[4]);
  const records = Number(process.argv[2] || 200000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-usage-bench-'));
  try {
    const written = writeFixture(dir, records);
    process.stdout.write(`${written} records, ${DAYS} days, ${CALLERS} callers (node ${process.version})\n`);
    for (const who of ['admin', 'plain', 'plain-all']) {
      const r = spawnSync(process.execPath, [__filename, '--case', dir, who], {encoding: 'utf8'});
      if (r.status !== 0) throw new Error(r.stderr);
      process.stdout.write(`${r.stdout}\n`);
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exitCode = 1; });
