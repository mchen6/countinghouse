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
// A record's time: ISO-8601 UTC, as the recorder writes it (toISOString).
const ISO_UTC = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?Z$/;
const FILE = /^(\d+)-(\d+)\.jsonl$/;
const COUNTERS = ['bytesIn', 'linesIn', 'bytesOut', 'linesOut'];

// One parsed line -> the record with every field present (absent counters 0,
// an absent server null), or null when it is not a record.
function normalise(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r) || typeof r.t !== 'string' || !ISO_UTC.test(r.t) || typeof r.tool !== 'string') return null;
  if (r.server !== undefined && r.server !== null && typeof r.server !== 'string') return null;
  const out = {...r, server: typeof r.server === 'string' ? r.server : null};
  for (const k of COUNTERS) {
    const v = r[k] === undefined ? 0 : r[k];
    if (!Number.isInteger(v) || v < 0) return null;
    out[k] = v;
  }
  return out;
}

// 'YYYY-MM-DD' moved by n days (UTC).
// (within 0000-01-01..9999-12-31: past them an ISO date no longer compares
// as text)
const shiftDay = (day, n) => {
  const shifted = new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  return DATE.test(shifted) ? shifted : (n < 0 ? '0000-01-01' : '9999-12-31');
};

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
  // A directory is named for a day that may differ from its records' UTC
  // dates by one (a writer naming it by local time), so only one more than a
  // day outside since..until is skipped unread (review of #59): a report reads
  // its window's directories, not the whole history.
  const from = since === undefined ? undefined : shiftDay(since, -1);
  const to = until === undefined ? undefined : shiftDay(until, 1);
  for (const day of list(usage).filter((d) => DATE.test(d) && (from === undefined || d >= from) && (to === undefined || d <= to))) {
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

// The same records, streamed (in chunks, never a whole file) and
// filtered as they are read, for the report (review of #158): `caller` (an
// opaque id, or null for every caller's) and `from`/`to` (ISO times,
// inclusive). A line that cannot be the caller's (its "caller" field is not
// in it) or whose leading time is outside from..to is skipped before it is
// parsed; every kept record is checked again after. since/until/skip as
// readUsage. -> Promise of the records, with filesRead: how many files were
// opened, whether or not any line in them was kept.
async function streamUsage(usage, {since, until, skip, from, to, caller = null} = {}) {
  const records = [];
  let filesRead = 0;
  const needle = caller == null ? null : `"caller":${JSON.stringify(caller)}`;
  const inTime = (t) => (from === undefined || t >= from) && (to === undefined || t <= to);
  const first = (since === undefined) ? undefined : shiftDay(since, -1);
  const last = (until === undefined) ? undefined : shiftDay(until, 1);
  // One line: filtered before it is parsed where a cheap check can tell, and
  // checked again after.
  const take = (line, processName) => {
    if (line.trim() === '') return;
    if (needle != null && !line.includes(needle)) return;
    // The recorder writes t first, as toISOString: {"t":"YYYY-MM-DDTHH:MM:SS.mmmZ",...
    if (line.startsWith('{"t":"') && line.charAt(30) === '"' && ISO_UTC.test(line.slice(6, 30)) && !inTime(line.slice(6, 30))) return;
    let parsed;
    try { parsed = JSON.parse(line); } catch { return; }
    const r = normalise(parsed);
    if (r === null || (caller != null && r.caller !== caller) || !inTime(r.t)) return;
    const date = r.t.slice(0, 10);
    if ((since !== undefined && date < since) || (until !== undefined && date > until)) return;
    records.push({...r, process: processName});
  };
  for (const day of list(usage).filter((d) => DATE.test(d) && (first === undefined || d >= first) && (last === undefined || d <= last))) {
    for (const file of list(path.join(usage, day)).filter((f) => FILE.test(f) && f !== `${skip}.jsonl`)) {
      const processName = file.slice(0, -'.jsonl'.length);
      filesRead += 1;
      // Streamed in chunks; the lines of each chunk are taken at once, and a
      // line cut by a chunk's end waits for the next.
      let rest = '';
      try {
        for await (const chunk of fs.createReadStream(path.join(usage, day, file), {encoding: 'utf8', highWaterMark: 1 << 20})) {
          const lines = (rest + chunk).split('\n');
          rest = lines.pop();
          for (const line of lines) take(line, processName);
        }
        take(rest, processName);
      } catch {
        // a file that cannot be read (removed, unreadable): what was read stands
      }
    }
  }
  records.filesRead = filesRead;
  return records;
}

module.exports = {readUsage, streamUsage, normalise, DATE, ISO_UTC};
