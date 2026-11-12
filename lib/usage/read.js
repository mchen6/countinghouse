'use strict';
// The runtime's usage records, read from <usageDir>/<YYYY-MM-DD>/<pid>-<startMs>.jsonl:
// one append-only file per launcher process, one JSON record per line, in the
// shape of the local-mode spec (§5), with `caller`, the opaque caller id. An "In" record (a call to
// a declared server) carries server, tool and the In counters; an "Out" record
// (a tools/call result) carries pack, tool and the Out counters; fields that do
// not apply are absent. Reading needs no running runtime and no port.
// Moved here from ch-report (local-mode spec §5: the report is the runtime's).
const fs = require('fs');
const path = require('path');

const DATE = /^\d{4}-\d\d-\d\d$/;
const FILE = /^(\d+)-(\d+)\.jsonl$/;
const COUNTERS = ['bytesIn', 'linesIn', 'bytesOut', 'linesOut'];

// One parsed line -> the record with every field present (absent counters 0,
// an absent server null), or null when it is not a record.
function normalise(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r) || typeof r.t !== 'string' || typeof r.tool !== 'string') return null;
  if (r.server !== undefined && r.server !== null && typeof r.server !== 'string') return null;
  const out = {...r, server: typeof r.server === 'string' ? r.server : null};
  for (const k of COUNTERS) {
    const v = r[k] === undefined ? 0 : r[k];
    if (!Number.isInteger(v) || v < 0) return null;
    out[k] = v;
  }
  return out;
}

const list = (dir) => {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
};

// -> records, oldest directory first, each with `process` (its file's
// "<pid>-<startMs>"). since/until are YYYY-MM-DD, inclusive, on each record's
// own time (UTC), whatever day its directory is named for. A line that is not
// a whole record (the truncated last line of a process stopped mid-write) is
// skipped.
// `skip`: a process ("<pid>-<startMs>") whose file is not read, the current
// process, whose records the report takes from memory.
function readUsage(usage, {since, until, skip} = {}) {
  const records = [];
  for (const day of list(usage).filter((d) => DATE.test(d))) {
    for (const file of list(path.join(usage, day)).filter((f) => FILE.test(f) && f !== `${skip}.jsonl`)) {
      let text;
      try { text = fs.readFileSync(path.join(usage, day, file), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        const r = normalise(parsed);
        if (r === null) continue;
        const date = r.t.slice(0, 10);
        if ((since !== undefined && date < since) || (until !== undefined && date > until)) continue;
        records.push({...r, process: file.slice(0, -'.jsonl'.length)});
      }
    }
  }
  return records;
}

module.exports = {readUsage, normalise, DATE};
