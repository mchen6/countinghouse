// A module's stdout and stderr under audit and enforce: runtime-owned
// streams in place of Node's own (the review of #186). Node's worker stdio
// streams hold its internal port to the main thread (process.stdout's kPort
// symbol); a message on it that is not stdio is decoded on the main thread
// with no bound, then refused there as an unknown type. So module code
// never gets them: installModuleStdio(), called by the lockdown before any
// module code runs, defines process.stdout, process.stderr and
// process.stdin as fixed getters returning streams of the runtime's, and
// points console at them. What a module writes goes to the main thread as
// 'stdout' and 'stderr' messages (envelopes, #170) through the worker's own
// pinned port, where lib/worker-output.js cuts lines, strips control
// characters and keeps a budget per stream.
//
// Here, in the worker, each stream keeps a budget of STREAM_BUDGET bytes a
// minute: past it what is written is dropped and counted, and the count
// goes to the main thread within DROP_REPORT_MS (a worker that is
// terminated never runs its exit handlers), where it is added up and said
// once a minute. Writes are gathered and sent at
// most every GAP_MS, in pieces of at most PIECE characters.
//
// Under --moduleSandbox off nothing here runs: off decides nothing.
const {Writable, Readable} = require('stream');
const {StringDecoder} = require('string_decoder');
const WorkerMessage = require('./worker-message');

const {STREAM_BUDGET, WINDOW_MS} = require('./output-limits');

const PIECE         = 64 * 1024;
const GAP_MS        = 10;
const DROP_REPORT_MS = 1000;
const BYTE_ENCODINGS = new Set(['hex', 'base64', 'base64url']);

// One module stream. send(data) posts {text} or {dropped}; now() is the clock.
function moduleStream(name, send, now) {
  const decoder = new StringDecoder('utf8');
  let pending = [];
  let pendingLength = 0;
  let scheduled = false;
  let lastSent = 0;
  let windowStart = now();
  let used = 0;
  let dropped = 0;
  let dropTimer = null;

  const reportDropped = () => {
    if (dropTimer != null) clearTimeout(dropTimer);
    dropTimer = null;
    if (dropped > 0) send(name, {dropped});
    dropped = 0;
  };
  const roll = () => {
    if (now() - windowStart < WINDOW_MS) return;
    reportDropped();
    windowStart = now();
    used = 0;
  };
  const flush = () => {
    scheduled = false;
    if (pendingLength === 0) return;
    const text = pending.join('');
    pending = [];
    pendingLength = 0;
    lastSent = now();
    // in pieces, never splitting a surrogate pair
    for (let i = 0; i < text.length;) {
      let end = Math.min(i + PIECE, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
      send(name, {text: text.slice(i, end)});
      i = end;
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const wait = GAP_MS - (now() - lastSent);
    if (wait <= 0) setImmediate(flush);
    else setTimeout(flush, wait);
  };

  // A string keeps its own encoding (decodeStrings: false); bytes are
  // read as UTF-8. Counted as the UTF-8 the main thread will count.
  const stream = new Writable({
    decodeStrings: false,
    write(chunk, encoding, callback) {
      roll();
      const n = typeof(chunk) === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.length;
      if (used + n > STREAM_BUDGET) {
        dropped += n;
        // what a dropped write left half-decoded is not glued to the next
        decoder.end();
        if (dropTimer == null) {
          dropTimer = setTimeout(reportDropped, DROP_REPORT_MS);
          dropTimer.unref();
        }
      } else {
        // a string is the text whatever encoding it would be written in,
        // but a hex or base64 string stands for bytes
        const text = typeof(chunk) === 'string'
          ? (BYTE_ENCODINGS.has(String(encoding).toLowerCase()) ? Buffer.from(chunk, encoding).toString('utf8') : chunk)
          : decoder.write(chunk);
        used += Buffer.byteLength(text);
        if (text !== '') {
          pending.push(text);
          pendingLength += text.length;
          schedule();
        }
      }
      callback();
    }
  });
  // As Node's own worker stdio streams are: a module may test for these.
  stream.isTTY = false;
  stream.fd = name === 'stdout' ? 1 : 2;
  return {stream, flush, roll, reportDropped};
}

// The stand-in for process.stdin: a module worker has no input.
function emptyInput() {
  const input = new Readable({read() { this.push(null); }});
  input.fd = 0;
  input.isTTY = false;
  return input;
}

// Replaces the worker's stdio streams for module code (see above). Returns
// {stdout, stderr} (the module streams). originals: Node's three streams,
// taken before the replacement.
function installModuleStdio(opts) {
  opts = opts || {};
  const send = opts.send || WorkerMessage.sendOutput;
  const now = opts.now || Date.now;
  const originals = {stdout: process.stdout, stderr: process.stderr, stdin: process.stdin};
  const out = moduleStream('stdout', send, now);
  const err = moduleStream('stderr', send, now);
  const streams = {stdout: out.stream, stderr: err.stream, stdin: emptyInput()};

  // Node's worker answers the main thread's acknowledgement of a write it
  // made before this ran by calling process[stream][kStdioWantsMoreDataCallback]():
  // each module stream answers it for its original, which it never exposes.
  for (const k of ['stdout', 'stderr', 'stdin']) {
    let proto = Object.getPrototypeOf(originals[k]);
    let key = null;
    for (; proto != null && key == null; proto = Object.getPrototypeOf(proto)) {
      key = Object.getOwnPropertySymbols(proto).find((s) => s.description === 'kStdioWantsMoreDataCallback') || null;
    }
    if (key != null) {
      const original = originals[k];
      Object.defineProperty(streams[k], key, {value: () => original[key](), writable: false, configurable: false, enumerable: false});
    }
  }

  for (const k of ['stdout', 'stderr', 'stdin']) {
    Object.defineProperty(process, k, {get: () => streams[k], configurable: false, enumerable: true});
  }
  // console caches the stream it first wrote to (its _stdout and _stderr):
  // pointed at the module streams, for good.
  Object.defineProperty(console, '_stdout', {get: () => streams.stdout, configurable: false, enumerable: false});
  Object.defineProperty(console, '_stderr', {get: () => streams.stderr, configurable: false, enumerable: false});
  // _rawDebug writes to the process's stderr directly, past every cap.
  Object.defineProperty(process, '_rawDebug', {value: (...args) => { streams.stderr.write(`${args.map(String).join(' ')}\n`); },
    writable: false, configurable: false, enumerable: false});

  // What is left goes before each of the runtime's replies (a worker the
  // main thread ends after its reply never runs its exit handlers) and
  // before the worker ends; a quiet stream's drop count once its minute is over.
  const flushAll = () => { out.flush(); err.flush(); out.reportDropped(); err.reportDropped(); };
  WorkerMessage.setBeforeReply(flushAll);
  process.on('exit', flushAll);
  const timer = setInterval(() => { out.roll(); err.roll(); }, WINDOW_MS);
  timer.unref();
  return {stdout: out.stream, stderr: err.stream};
}

module.exports = {installModuleStdio, PIECE};
