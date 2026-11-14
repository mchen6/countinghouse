// What a module's worker sends the main thread to be written reaches the
// operator bounded (the review of #186). Two kinds, both messages through
// the worker's own port, each an envelope under #170's cap:
//
// - 'stdout' and 'stderr': the module's output under audit and enforce
//   (lib/worker-stdio.js), {lines} or {dropped}. onOutput() cuts each line
//   at LINE_MAX bytes (with "…"), removes control characters other than \t,
//   the line separators and the bidi controls (lib/output-lines.js: no
//   terminal escapes or reordering in the operator's log) and writes each
//   prefixed with the module's name: under --stdio both go to stderr (stdout
//   is the MCP channel), else each to the process's own. Each line is
//   charged what writing it costs (prefix, bytes, newline), as in the
//   worker, which keeps STREAM_BUDGET bytes a minute; here the backstop is
//   STREAM_BACKSTOP (the two sides' windows do not line up, and an honest
//   worker is never dropped here). Past it lines are dropped and counted with
//   what the worker dropped, and one line a minute says how much:
//   "<module>: N bytes of stdout dropped".
// - 'log': the worker's own log records (lib/worker-logger.js), {level, msg,
//   e, de, lost}. onLog() cuts each field at FIELD_MAX bytes, cleans it as a
//   line is (keeping \n), and writes the record with the main thread's
//   logger, the module named by the main thread (never by the record). Each
//   record costs RECORD_MIN bytes plus its fields, against LOG_BUDGET bytes
//   a minute per worker; past it, and for the records the worker says it
//   lost, dropped and counted, one summary line a minute.
//
// The caps are constants, not options (docs/security-model.md).
const options = require('./cli-options');
const LOG = require('./logger');
const {STREAM_BACKSTOP, LOG_BUDGET, FIELD_MAX, RECORD_MIN, BATCH_UNITS, ROLL_EVERY_MS} = require('./output-limits');
const {cutTo, lineOf, lineCost, cleanField, Budget} = require('./output-lines');
// The most records one 'lost' count stands for: a worker's word, bounded.
const LOST_MAX = 1000000;

// The name a worker's lines carry: the module's, as the main thread loaded it.
const nameOf = (wm) => wm.hostModuleName || wm.logName || '(a module loading)';

// Where a module's lines go: under --stdio stderr for both (stdout is the
// MCP channel); else each to the process's own. A test replaces it.
let sink = (stream, line) => {
  const target = (stream === 'stderr' || options.stdio === true) ? process.stderr : process.stdout;
  target.write(`${line}\n`);
};

// A worker's state here, made on its first message; its timer rolls the
// budgets once a minute, so a quiet worker still says what it dropped.
function stateOf(wm) {
  if (wm.outputState != null) return wm.outputState;
  const s = {streams: {}, log: new Budget(LOG_BUDGET), timer: null};
  s.log.onDropped = (d) => LOG.W(`${nameOf(wm)}: ${d.items} log records (${d.bytes} bytes) dropped`);
  for (const stream of ['stdout', 'stderr']) {
    const budget = new Budget(STREAM_BACKSTOP);
    budget.onDropped = (d) => sink(stream, `${nameOf(wm)}: ${d.bytes} bytes of ${stream} dropped`);
    s.streams[stream] = {budget};
  }
  s.timer = setInterval(() => { s.log.roll(); s.streams.stdout.budget.roll(); s.streams.stderr.budget.roll(); }, ROLL_EVERY_MS);
  s.timer.unref();
  wm.outputState = s;
  return s;
}

// The lines of one output message, as the worker sends them: at most a
// batch's worth, each a string; null for anything else, which is not output.
const linesOf = (data) => {
  if (data == null || !Array.isArray(data.lines) || data.lines.length > BATCH_UNITS) return null;
  return data.lines.every((l) => typeof(l) === 'string') ? data.lines : null;
};

// One 'stdout' or 'stderr' message from a module's worker: {lines} or
// {dropped}. Each line is cut and cleaned again (the worker did, but this
// thread does not take its word for it) and charged what writing it costs.
function onOutput(wm, stream, data) {
  if (data == null || typeof(data) !== 'object') return;
  const s = stateOf(wm).streams[stream];
  if (Number.isSafeInteger(data.dropped) && data.dropped > 0) s.budget.drop(Math.min(data.dropped, Number.MAX_SAFE_INTEGER / 4), 0);
  if (data.lines === undefined) return s.budget.roll();
  const lines = linesOf(data);
  // a message that is not a list of lines is counted, never ignored silently
  if (lines == null) return s.budget.drop(1, 1);
  const prefix = `${nameOf(wm)}: `;
  const prefixBytes = Buffer.byteLength(prefix);
  for (const raw of lines) {
    const line = lineOf(raw);
    if (s.budget.take(lineCost(prefixBytes, line))) sink(stream, `${prefix}${line}`);
  }
}

// What a log record costs: RECORD_MIN, and its fields' bytes.
const recordCost = (fields) => RECORD_MIN + Buffer.byteLength(fields.msg || '') + Buffer.byteLength(fields.e || '') + Buffer.byteLength(fields.de || '');

// A 'log', 'stdout' or 'stderr' message past --moduleMessageRate: dropped
// without an answer, and counted with what the budgets drop.
function onRateDropped(wm, command, data) {
  const s = stateOf(wm);
  if (command === 'log') {
    const r = (data != null && typeof(data) === 'object') ? data : {};
    const size = (v) => (typeof(v) === 'string' ? Buffer.byteLength(v) : 0);
    return s.log.drop(RECORD_MIN + size(r.msg) + size(r.e) + size(r.de), 1);
  }
  const st = s.streams[command];
  if (st == null) return;
  // charged as they came, not cleaned first: dropping stays cheap
  const prefixBytes = Buffer.byteLength(`${nameOf(wm)}: `);
  const lines = linesOf(data) || [];
  st.budget.drop(Math.max(1, lines.reduce((n, l) => n + prefixBytes + Buffer.byteLength(l) + 1, 0)), 1);
}

const LEVELS = new Map([[30, 'info'], [40, 'warn'], [50, 'error'], [60, 'fatal']]);
// a field cut and cleaned (it keeps \n: the log escapes it)
function field(v) { return v == null ? undefined : cleanField(cutTo(String(v), FIELD_MAX)); }

// One log record from a module's worker ({level, msg, e, de}).
function onLog(wm, record) {
  if (record == null || typeof(record) !== 'object') return;
  const fields = {msg: field(record.msg), e: field(record.e), de: field(record.de)};
  const log = stateOf(wm).log;
  // records the worker could not send are counted, never lost silently
  if (Number.isSafeInteger(record.lost) && record.lost > 0) {
    const lost = Math.min(record.lost, LOST_MAX);
    log.drop(lost * RECORD_MIN, lost);
  }
  // a count alone (the worker's, before a reply or at its end) writes nothing
  if (fields.msg === undefined && fields.e === undefined && fields.de === undefined && record.lost !== undefined) return;
  if (!log.take(recordCost(fields))) return;
  const rec = {module: nameOf(wm)};
  if (fields.e !== undefined) rec.e = fields.e;
  if (fields.de !== undefined) rec.de = fields.de;
  LOG.logger[LEVELS.get(record.level) || 'info'](rec, fields.msg !== undefined ? fields.msg : '');
}

// The worker has ended: its unfinished lines and what it dropped are said
// now, and its timer stops.
function end(wm) {
  const s = wm.outputState;
  if (s == null) return;
  clearInterval(s.timer);
  for (const stream of ['stdout', 'stderr']) s.streams[stream].budget.roll(true);
  s.log.roll(true);
  wm.outputState = null;
}

module.exports = {onOutput, onLog, onRateDropped, end, setSink: (fn) => { sink = fn; }};
