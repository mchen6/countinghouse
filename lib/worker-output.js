// What a module's worker sends the main thread to be written reaches the
// operator bounded (the review of #186). Two kinds, both messages through
// the worker's own port, each an envelope under #170's cap:
//
// - 'stdout' and 'stderr': the module's output under audit and enforce
//   (lib/worker-stdio.js), {text} or {dropped}. onOutput() splits it into
//   lines, cuts each at LINE_MAX bytes (with "…"), removes control characters
//   other than \t (no terminal escapes in the operator's log) and writes each
//   prefixed with the module's name: under --stdio both go to stderr (stdout
//   is the MCP channel), else each to the process's own. Each stream has
//   STREAM_BUDGET bytes a minute here too; past it, what comes is dropped and
//   counted with what the worker dropped, and one line a minute says how
//   much: "<module>: N bytes of stdout dropped".
// - 'log': the worker's own log records (lib/worker-logger.js), {level, msg,
//   e, de}. onLog() cuts each field at FIELD_MAX characters and writes the
//   record with the main thread's logger, the module named by the main thread
//   (never by the record), LOG_BUDGET bytes a minute per worker; past it
//   dropped and counted, one summary line a minute.
//
// The caps are constants, not options (docs/security-model.md).
const {StringDecoder} = require('string_decoder');
const options = require('./cli-options');
const LOG = require('./logger');

const {LINE_MAX, STREAM_BUDGET, LOG_BUDGET, FIELD_MAX, WINDOW_MS, CUT} = require('./output-limits');
// How often a worker's budgets are looked at: a window that has ended is
// said within this of its end.
const ROLL_EVERY_MS = 5000;

// C0 controls but \t, DEL, and the C1 controls (U+0080-U+009F: U+009B is a
// CSI on its own on some terminals). \n never reaches here: it splits lines.
const CONTROLS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;
const clean = (s) => s.replace(CONTROLS, '');

// s cut to max bytes of UTF-8, "…" included; a character is never split.
const cutTo = (s, max) => {
  if (Buffer.byteLength(s) <= max) return s;
  const b = Buffer.from(s).subarray(0, max - Buffer.byteLength(CUT));
  return new StringDecoder('utf8').write(b).replace(/�$/, '') + CUT;
};

// Text to whole lines: push(text) returns the finished lines, each cut to
// LINE_MAX bytes and cleaned. A line still open past LINE_MAX is emitted cut
// at once, and the rest of it, up to its newline, is skipped.
function LineSplitter() {
  this.partial = '';
  this.skipping = false;
}

LineSplitter.prototype.push = function(text) {
  const out = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const piece = text.slice(start, nl < 0 ? text.length : nl);
    if (!this.skipping) {
      this.partial += piece;
      if (this.partial.length > LINE_MAX / 4 && Buffer.byteLength(this.partial) > LINE_MAX) {
        out.push(clean(cutTo(this.partial, LINE_MAX)));
        this.partial = '';
        this.skipping = true;
      }
    }
    if (nl < 0) break;
    if (!this.skipping) out.push(clean(this.partial));
    this.partial = '';
    this.skipping = false;
    start = nl + 1;
  }
  return out;
};

// What is left when the worker ends: an unfinished line, if any.
LineSplitter.prototype.end = function() {
  const rest = this.skipping ? '' : this.partial;
  this.partial = '';
  this.skipping = false;
  return rest !== '' ? [clean(rest)] : [];
};

// A per-minute byte budget. take(n) is true while it lasts; what is past it
// is counted, as is what the worker says it dropped (drop(n)), and onDropped
// is told once a window with something dropped is over (roll()).
function Budget(limit, now) {
  this.limit = limit;
  this.now = now || Date.now;
  this.windowStart = this.now();
  this.used = 0;
  this.dropped = 0;
  this.droppedItems = 0;
  this.onDropped = null;
}

Budget.prototype.take = function(n) {
  this.roll();
  if (this.used + n > this.limit) {
    this.drop(n);
    return false;
  }
  this.used += n;
  return true;
};

Budget.prototype.drop = function(n) {
  this.dropped += n;
  this.droppedItems += 1;
};

Budget.prototype.roll = function(force) {
  if (force !== true && this.now() - this.windowStart < WINDOW_MS) return;
  const was = this.dropped > 0 ? {bytes: this.dropped, items: this.droppedItems} : null;
  this.windowStart = this.now();
  this.used = 0;
  this.dropped = 0;
  this.droppedItems = 0;
  if (was != null && typeof(this.onDropped) === 'function') this.onDropped(was);
};

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
    const budget = new Budget(STREAM_BUDGET);
    budget.onDropped = (d) => sink(stream, `${nameOf(wm)}: ${d.bytes} bytes of ${stream} dropped`);
    s.streams[stream] = {split: new LineSplitter(), budget};
  }
  s.timer = setInterval(() => { s.log.roll(); s.streams.stdout.budget.roll(); s.streams.stderr.budget.roll(); }, ROLL_EVERY_MS);
  s.timer.unref();
  wm.outputState = s;
  return s;
}

// One 'stdout' or 'stderr' message from a module's worker: {text} or {dropped}.
function onOutput(wm, stream, data) {
  if (data == null || typeof(data) !== 'object') return;
  const s = stateOf(wm).streams[stream];
  if (Number.isSafeInteger(data.dropped) && data.dropped > 0) s.budget.drop(data.dropped);
  if (typeof(data.text) !== 'string') return s.budget.roll();
  if (!s.budget.take(Buffer.byteLength(data.text))) return endLine(wm, stream, s);
  for (const line of s.split.push(data.text)) sink(stream, `${nameOf(wm)}: ${line}`);
}

// Output was dropped mid-line: the part already here is a line of its own,
// never glued to what comes after the gap.
function endLine(wm, stream, s) {
  for (const line of s.split.end()) sink(stream, `${nameOf(wm)}: ${line}`);
}

// A 'log', 'stdout' or 'stderr' message past --moduleMessageRate: dropped
// without an answer, and counted with what the budgets drop.
function onRateDropped(wm, command, data) {
  const s = stateOf(wm);
  if (command === 'log') return s.log.drop(data != null && typeof(data.msg) === 'string' ? Buffer.byteLength(data.msg) : 0);
  const st = s.streams[command];
  if (st == null) return;
  st.budget.drop(data != null && typeof(data.text) === 'string' ? Buffer.byteLength(data.text) : 0);
  endLine(wm, command, st);
}

const LEVELS = new Map([[30, 'info'], [40, 'warn'], [50, 'error'], [60, 'fatal']]);
const field = (v) => (v == null ? undefined : cutTo(String(v), FIELD_MAX));

// One log record from a module's worker ({level, msg, e, de}).
function onLog(wm, record) {
  if (record == null || typeof(record) !== 'object') return;
  const fields = {msg: field(record.msg), e: field(record.e), de: field(record.de)};
  const size = Buffer.byteLength(fields.msg || '') + Buffer.byteLength(fields.e || '') + Buffer.byteLength(fields.de || '');
  if (!stateOf(wm).log.take(size)) return;
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
  for (const stream of ['stdout', 'stderr']) {
    for (const line of s.streams[stream].split.end()) sink(stream, `${nameOf(wm)}: ${line}`);
    s.streams[stream].budget.roll(true);
  }
  s.log.roll(true);
  wm.outputState = null;
}

module.exports = {onOutput, onLog, onRateDropped, end, LineSplitter, Budget, LINE_MAX, STREAM_BUDGET, LOG_BUDGET, FIELD_MAX, WINDOW_MS,
  setSink: (fn) => { sink = fn; }};
