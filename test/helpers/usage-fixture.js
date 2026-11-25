'use strict';
// Writes a fixture usage directory (moved here from ch-report's test support), in the layout and
// record shape of the local-mode spec (§5):
// <usageDir>/<YYYY-MM-DD>/<pid>-<startMs>.jsonl, one JSON record per line.
// Every record carries `caller`: u_alice for the most, u_bob for the 11-11 report call.
// An "In" record is one call to a declared server: {t, call, server, tool (the
// server's tool), bytesIn, ms, outcome, credential}. An "Out" record
// is a tools/call result: {t, call, pack, tool (the scenario's tool), bytesOut,
// ms, outcome}. Fields that do not apply are absent. `call` is a
// per-process counter that ties a tools/call's In records to its Out record;
// the file names the process. No value in it is a secret: credential is a
// variable's name.
const fs = require('fs');
const path = require('path');

const PACK = 'ch-pack-ci-failure-triage';
const TOOL = 'ci_failure_triage';

const inRec = (t, call, tool, bytesIn) => ({t, call, server: 'github', tool, bytesIn, ms: 100, outcome: 'ok', credential: 'GITHUB_TOKEN', caller: 'u_alice'});
const outRec = (t, call, bytesOut, outcome = 'ok') => ({t, call, pack: PACK, tool: TOOL, bytesOut, ms: 900, outcome, caller: 'u_alice'});

const FILES = {
  // Before the window the tests use (--since 2026-11-10).
  '2026-11-09/1000-1794214800000.jsonl': [inRec('2026-11-09T09:00:00.000Z', 1, 'get_job_logs', 999), outRec('2026-11-09T09:00:01.000Z', 1, 99)],
  '2026-11-10/1111-1794304800000.jsonl': [
    inRec('2026-11-10T10:00:01.000Z', 1, 'get_job_logs', 4000),
    inRec('2026-11-10T10:00:02.000Z', 1, 'actions_list', 8000),
    outRec('2026-11-10T10:00:03.000Z', 1, 1200)
  ],
  '2026-11-11/2222-1794391200000.jsonl': [
    inRec('2026-11-11T10:00:01.000Z', 1, 'actions_list', 1000),
    inRec('2026-11-11T10:00:02.000Z', 1, 'get_job_logs', 2000),
    inRec('2026-11-11T10:00:03.000Z', 1, 'get_job_logs', 3000),
    outRec('2026-11-11T10:00:04.000Z', 1, 800),
    {t: '2026-11-11T11:00:00.000Z', call: 2, pack: 'ch-report', tool: 'usage_report', bytesOut: 402, ms: 5, outcome: 'ok', caller: 'u_bob'}
  ]
};

// A process stopped mid-call: call 2's server call has no result, and the
// line being written is truncated.
const TRUNCATED = {
  file: '2026-11-11/3333-1794394800000.jsonl',
  records: [outRec('2026-11-11T12:00:00.000Z', 1, 400, 'error'), inRec('2026-11-11T12:00:05.000Z', 2, 'get_job_logs', 500)],
  tail: '{"t":"2026-11-11T12:00:06.000Z","call":2,"pa'
};

function writeUsageFixture(usageDir) {
  for (const [rel, records] of Object.entries(FILES)) {
    const file = path.join(usageDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, records.map((r) => `${JSON.stringify(r)  }\n`).join(''));
  }
  const file = path.join(usageDir, ...TRUNCATED.file.split('/'));
  fs.writeFileSync(file, TRUNCATED.records.map((r) => `${JSON.stringify(r)  }\n`).join('') + TRUNCATED.tail);
  return usageDir;
}

module.exports = {writeUsageFixture, PACK, TOOL};
