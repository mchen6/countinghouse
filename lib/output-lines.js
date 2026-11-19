'use strict';
// Lines of a module's output, and what they cost, the same in the worker
// (lib/worker-stdio.js) and on the main thread (lib/worker-output.js), so
// the two budgets charge the same bytes and their windows agree (the review
// of #190). A line costs what writing it costs: the "<module>: " prefix, its
// bytes after cutting and cleaning, and the newline, so a flood of empty
// lines is charged for the lines it writes, not the one byte each it took in.
const {StringDecoder} = require('string_decoder');
const {LINE_MAX, WINDOW_MS, CUT} = require('./output-limits');

// The one class's controls, separators and bidi controls dropped (lib/
// module-text.js withoutControlOrBidi, the subset the declarations gate
// refuses), a \t kept: the controls (U+009B is a CSI on its own on some
// terminals), the line and paragraph separators, and the bidi overrides,
// isolates and marks, which reorder what an operator reads. The rest of the
// class is for the client-facing cleaner (a question's dialog: module-
// questions). \n splits lines before this runs. It runs in the module's own
// worker on the built-ins module-text took at load, so a module patching
// them can't get a control character into its own lines.
const {withoutControlOrBidi} = require('./module-text');
const TAB = new Set(['\t']);
const clean = (s) => withoutControlOrBidi(s, TAB);
// A log field keeps its \n too (a stack's lines; the log escapes it as JSON).
const TAB_AND_NEWLINE = new Set(['\t', '\n']);
const cleanField = (s) => withoutControlOrBidi(s, TAB_AND_NEWLINE);

// s cut to max bytes of UTF-8, "…" included; a character is never split.
const cutTo = (s, max) => {
  if (Buffer.byteLength(s) <= max) return s;
  const b = Buffer.from(s).subarray(0, max - Buffer.byteLength(CUT));
  return new StringDecoder('utf8').write(b).replace(/\uFFFD$/, '') + CUT;
};

// One line as it is written: cut to LINE_MAX bytes, cleaned.
const lineOf = (s) => clean(cutTo(s, LINE_MAX));

// What writing a line costs, with prefixBytes of "<module>: " before it.
const lineCost = (prefixBytes, line) => prefixBytes + Buffer.byteLength(line) + 1;

// Text to whole lines: push(text) returns the finished lines, each as
// lineOf() makes it. A line still open past LINE_MAX is emitted cut at once,
// and the rest of it, up to its newline, is skipped.
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
      // no line of 2048 UTF-16 units or fewer is over 8 KiB of UTF-8
      if (this.partial.length > LINE_MAX / 4 && Buffer.byteLength(this.partial) > LINE_MAX) {
        out.push(lineOf(this.partial));
        this.partial = '';
        this.skipping = true;
      }
    }
    if (nl < 0) break;
    if (!this.skipping) out.push(lineOf(this.partial));
    this.partial = '';
    this.skipping = false;
    start = nl + 1;
  }
  return out;
};

// What is left at the end: an unfinished line, if any.
LineSplitter.prototype.end = function() {
  const rest = this.skipping ? '' : this.partial;
  this.partial = '';
  this.skipping = false;
  return rest !== '' ? [lineOf(rest)] : [];
};

// A per-minute byte budget. take(n) is true while it lasts; what is past it
// is counted (drop(bytes, items)), and onDropped is told once a window with
// something dropped is over (roll()).
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
    this.drop(n, 1);
    return false;
  }
  this.used += n;
  return true;
};

Budget.prototype.drop = function(bytes, items) {
  this.dropped += bytes;
  this.droppedItems += (items == null ? 1 : items);
};

Budget.prototype.roll = function(force) {
  if (force !== true && this.now() - this.windowStart < WINDOW_MS) return;
  const was = this.dropped > 0 || this.droppedItems > 0 ? {bytes: this.dropped, items: this.droppedItems} : null;
  this.windowStart = this.now();
  this.used = 0;
  this.dropped = 0;
  this.droppedItems = 0;
  if (was != null && typeof(this.onDropped) === 'function') this.onDropped(was);
};

module.exports = {clean, cleanField, cutTo, lineOf, lineCost, LineSplitter, Budget};
