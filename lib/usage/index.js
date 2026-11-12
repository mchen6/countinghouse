// Boundary counters and usage records (local-mode spec §5). Two counting
// points, both on the main thread:
//
//   In:  the remote client (RC1, A's) calls recordIn(call, {server, module,
//        tool, bytes, lines, ms, outcome, credential}) for every call to a
//        declared server it makes on behalf of tools/call `call`; `module` is
//        the friendlyName of the module that made it (the access module).
//        It is optional, and the report groups by it.
//   Out: the gateway calls recordOut(call, {tool, bytes, lines, ms, outcome})
//        with the counts of a listed module's tools/call result: its text
//        content after output validation, not the receipt sentence.
//
// beginCall({pack, tool, caller}) opens a call: `call` is a per-process
// counter, and `caller` the opaque caller id (R2-1's u_..., or the one local
// id in the single-identity profile), never a key or a user name. Every
// record is kept in memory at once, so a report a second later sees it, and,
// with a usage directory, appended as it happens to
// <usageDir>/<YYYY-MM-DD>/<pid>-<startMs>.jsonl, one JSON object per line. A
// crash loses at most the line being written. No credential value and no
// content is ever recorded: a credential is the name of the variable it came
// from.
//
// The receipt of a call sums its In records with its Out record: {calls,
// linesIn, bytesIn, linesOut, bytesOut, servers}. The gateway puts it in the
// result's _meta['countinghouse/receipt'] and its sentence in a second text
// block (reviewer, 2026-11-11).
const fs = require('fs');
const path = require('path');

// UTF-8 bytes and newline-separated lines; a trailing newline is not a line.
function countText(text) {
  const s = text == null ? '' : String(text);
  if (s === '') return {bytes: 0, lines: 0};
  return {bytes: Buffer.byteLength(s, 'utf8'), lines: s.split('\n').length - (s.endsWith('\n') ? 1 : 0)};
}

const n = (x) => x.toLocaleString('en-US');
function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const lines = (k) => `${n(k)} line${k === 1 ? '' : 's'}`;

// "read 48,210 lines (3.1 MB) in 14 calls to github and 2 to linear; 35 lines
// (2.4 KB) reached the model." `perServer`: {server: calls}. Never "saved".
function receiptSentence(receipt, perServer) {
  const out = `${lines(receipt.linesOut)} (${size(receipt.bytesOut)}) reached the model.`;
  if (receipt.calls === 0) return `no server was called; ${out}`;
  const calls = receipt.servers.map((s, i) => {
    const k = perServer[s] || 0;
    return i === 0 ? `${n(k)} call${k === 1 ? '' : 's'} to ${s}` : `${n(k)} to ${s}`;
  });
  return `read ${lines(receipt.linesIn)} (${size(receipt.bytesIn)}) in ${calls.join(' and ')}; ${out}`;
}

// The usage file writer: one open descriptor per day directory, appended to as
// each record happens.
function fileWriter(usageDir, pid, startMs) {
  let openDay = null;
  let fd = null;
  return (record) => {
    const dayOf = record.t.slice(0, 10);
    if (dayOf !== openDay) {
      if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* already closed */ } }
      const dir = path.join(usageDir, dayOf);
      fs.mkdirSync(dir, {recursive: true});
      fd = fs.openSync(path.join(dir, `${pid}-${startMs}.jsonl`), 'a');
      openDay = dayOf;
    }
    fs.appendFileSync(fd, `${JSON.stringify(record)}\n`);
  };
}

// A usage recorder. The runtime has one (lib/usage/runtime.js); tests make
// their own with a usage directory, pid, start time and clock of their choice.
//
// Bounded (review of #59): a call is open from beginCall to recordOut and
// then released, its receipt and sentence kept among the last FINISHED_MAX
// finished calls for the caller that asks right after; memory keeps the
// newest memoryMax records. With a usage directory the files are the record,
// and the report reads them, this process's own file included.
const MEMORY_MAX = 10000;
const FINISHED_MAX = 256;
function createUsage({usageDir = null, pid = process.pid, startMs = Date.now(), now = Date.now, memoryMax = MEMORY_MAX} = {}) {
  const memory = [];
  const calls = new Map(); // call -> {pack, module, tool, caller, in: [], out: null}
  const finished = new Map(); // call -> {receipt, sentence}, the newest FINISHED_MAX
  const write = usageDir != null ? fileWriter(usageDir, pid, startMs) : null;
  let next = 0;

  const keep = (record) => {
    memory.push(record);
    if (memory.length > memoryMax) memory.splice(0, memory.length - memoryMax);
    if (write != null) {
      try { write(record); } catch (_) { /* a full disk loses the file line, never the call */ }
    }
  };
  const open = (call) => {
    const c = calls.get(call);
    if (c == null) throw new Error(`usage: no call ${call} was begun`);
    return c;
  };

  return {
    process: `${pid}-${startMs}`,
    writesTo: usageDir,
    inFlight: () => calls.size,
    // Step 3c: the workers an open call is sent to (the gateway's and a task's
    // send, and each hop forwarded under it). Only they may state its id on a
    // hop (lib/usage/hop.js) or a remote message (A's step 5). A grant is
    // counted and returns its release (a hop's lasts while the hop runs); all
    // end with the call's Out record.
    grantCall(call, workerId) {
      const c = calls.get(call);
      if (c == null || workerId == null) return () => {};
      c.workers.set(workerId, (c.workers.get(workerId) || 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (c.workers.get(workerId) || 1) - 1;
        if (left > 0) c.workers.set(workerId, left); else c.workers.delete(workerId);
      };
    },
    ownsCall(call, workerId) {
      const c = calls.get(call);
      return c != null && workerId != null && (c.workers.get(workerId) || 0) > 0;
    },
    // An id this recorder minted whose call has ended (ids only go up).
    isFinished: (call) => Number.isInteger(call) && call >= 1 && call <= next && !calls.has(call),
    beginCall({pack = null, module = null, tool, caller = null}) {
      next += 1;
      calls.set(next, {pack, module: typeof module === 'string' ? module : null, tool, caller, in: [], out: null, workers: new Map()});
      return next;
    },
    recordIn(call, {server, module, tool, bytes, lines: l, ms, outcome, credential}) {
      const c = open(call);
      const record = {t: new Date(now()).toISOString(), call, server, ...(typeof module === 'string' ? {module} : {}), tool, bytesIn: bytes, linesIn: l, ms, outcome, credential: credential == null ? null : String(credential), caller: c.caller};
      c.in.push(record);
      keep(record);
    },
    recordOut(call, {tool, bytes, lines: l, ms, outcome}) {
      const c = open(call);
      const record = {t: new Date(now()).toISOString(), call, pack: c.pack, ...(c.module != null ? {module: c.module} : {}), tool, bytesOut: bytes, linesOut: l, ms, outcome, caller: c.caller};
      c.out = record;
      keep(record);
      const receipt = this.totals(call);
      const sentence = this.receiptSentenceOf(call);
      calls.delete(call);
      finished.set(call, {receipt, sentence});
      if (finished.size > FINISHED_MAX) finished.delete(finished.keys().next().value);
      return receipt;
    },
    totals(call) {
      if (!calls.has(call) && finished.has(call)) return {...finished.get(call).receipt};
      const c = open(call);
      const servers = [...new Set(c.in.map((r) => r.server))];
      return {
        calls: c.in.length,
        linesIn: c.in.reduce((s, r) => s + r.linesIn, 0),
        bytesIn: c.in.reduce((s, r) => s + r.bytesIn, 0),
        linesOut: c.out == null ? 0 : c.out.linesOut,
        bytesOut: c.out == null ? 0 : c.out.bytesOut,
        servers
      };
    },
    receiptSentenceOf(call) {
      if (!calls.has(call) && finished.has(call)) return finished.get(call).sentence;
      const c = open(call);
      const perServer = {};
      for (const r of c.in) perServer[r.server] = (perServer[r.server] || 0) + 1;
      return receiptSentence(this.totals(call), perServer);
    },
    // This process's records, oldest first (the report's memory source).
    records: () => memory.slice()
  };
}

module.exports = {createUsage, countText, receiptSentence, size};
