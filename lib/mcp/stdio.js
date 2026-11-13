// The --stdio route layer (local-mode spec §2): the MCP gateway's handle()
// served over newline-delimited JSON-RPC instead of HTTP. One request per
// line on the input, one response per line on the output, batches answered
// as lib/routes/mcp.js answers them (one handle per entry, in order, the
// notifications dropped). A notification (a message with no id) is handed to
// handle but never answered, whatever handle returns for it: over stdio an
// answer nobody asked for is an unsolicited message. Requests run
// concurrently and each response is one write, so lines never interleave. A
// line longer than maxLineBytes is refused, as the HTTP route refuses a body
// over --maxRequestBody.
//
// When the input ends (or errors, or closes), no new line is read and the
// calls in flight are drained, up to drainMs; `done` then resolves 0, or 1
// when the drain ran out or the output failed, and only once every answer
// already written has been flushed.
//
// It knows nothing of the server: `handle(message, appKey, cb)` is the
// gateway's handle with the interface bound, so the layer is tested over two
// in-memory streams.

const JSONRPC_PARSE_ERROR     = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_INTERNAL_ERROR  = -32603;
const DEFAULT_MAX_LINE_BYTES  = 8 * 1024 * 1024; // --maxRequestBody's default

const error = (id, code, message) => ({jsonrpc: '2.0', id: id === undefined ? null : id, error: {code, message}});
const isObject = (m) => m != null && typeof m === 'object' && !Array.isArray(m);
const isNotification = (m) => isObject(m) && !Object.prototype.hasOwnProperty.call(m, 'id');
const idOf = (m) => (isObject(m) ? m.id : null);

function serveStdio({input, output, handle, appKey, drainMs, maxLineBytes = DEFAULT_MAX_LINE_BYTES}) {
  let buffer = '';
  let bufferBytes = 0;
  let scanFrom = 0;
  let skipping = false;
  let ended = false;
  let inFlight = 0;
  let writing = 0;
  let finish = null;

  const done = new Promise((resolve) => {
    let resolved = false;
    finish = (code) => {
      if (resolved) return;
      resolved = true;
      const flushed = () => (writing === 0 ? resolve(code) : setImmediate(flushed));
      flushed();
    };
  });

  const write = (response) => {
    writing += 1;
    output.write(`${JSON.stringify(response)}\n`, () => { writing -= 1; });
  };

  // One message -> its response, or null: always null for a notification.
  const one = (message) => new Promise((resolve) => {
    const answer = (response) => resolve(isNotification(message) ? null : response);
    try {
      handle(message, appKey, (err, response) => answer(err != null ? error(idOf(message), JSONRPC_INTERNAL_ERROR, 'internal error') : response));
    } catch (_) {
      answer(error(idOf(message), JSONRPC_INTERNAL_ERROR, 'internal error'));
    }
  });

  let drainTimer = null;
  const settled = () => {
    inFlight -= 1;
    if (ended && inFlight === 0) { clearTimeout(drainTimer); finish(0); }
  };

  const serveLine = (line) => {
    if (line.trim() === '') return;
    let body;
    try {
      body = JSON.parse(line);
    } catch (_) {
      write(error(null, JSONRPC_PARSE_ERROR, 'parse error: the line is not JSON'));
      return;
    }
    if (Array.isArray(body) && body.length === 0) {
      write(error(null, JSONRPC_INVALID_REQUEST, 'invalid JSON-RPC 2.0 request: an empty batch'));
      return;
    }
    inFlight += 1;
    const answered = Array.isArray(body)
      ? body.reduce((p, m) => p.then((all) => one(m).then((r) => all.concat([r]))), Promise.resolve([]))
        .then((all) => { const kept = all.filter((r) => r != null); return kept.length === 0 ? null : kept; })
      : one(body);
    answered.then((response) => { if (response != null) write(response); }).then(settled, settled);
  };

  const tooLong = () => {
    write(error(null, JSONRPC_INVALID_REQUEST, `invalid JSON-RPC 2.0 request: the line is longer than ${maxLineBytes} bytes`));
    skipping = true;
    buffer = '';
    bufferBytes = 0;
    scanFrom = 0;
  };

  const read = (chunk) => {
    if (ended) return;
    buffer += chunk;
    bufferBytes += Buffer.byteLength(chunk);
    let newline;
    // Only the new part is searched: a long line in many chunks is scanned once.
    while ((newline = buffer.indexOf('\n', scanFrom)) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      bufferBytes = Buffer.byteLength(buffer);
      scanFrom = 0;
      if (skipping) { skipping = false; continue; }
      if (Buffer.byteLength(line) > maxLineBytes) { tooLong(); skipping = false; continue; }
      serveLine(line);
    }
    scanFrom = buffer.length;
    if (!skipping && bufferBytes > maxLineBytes) tooLong();
    else if (skipping) { buffer = ''; bufferBytes = 0; scanFrom = 0; }
  };

  const end = () => {
    if (ended) return;
    // The last line may have no newline of its own.
    if (buffer !== '' && !skipping) { const last = buffer.replace(/\r$/, ''); buffer = ''; serveLine(last); }
    ended = true;
    if (inFlight === 0) return finish(0);
    drainTimer = setTimeout(() => finish(1), drainMs);
  };

  input.setEncoding('utf8');
  input.on('data', read);
  input.on('end', end);
  input.on('close', end);
  input.on('error', end);
  if (typeof output.on === 'function') output.on('error', () => { ended = true; finish(1); });
  // A message the server sends unasked (a notification): one line, written as
  // an answer is; nothing once the input has ended or the output has failed.
  const notify = (message) => { if (!ended) write(message); };
  return {done, notify};
}

module.exports = {serveStdio};

// Under --stdio, stdout is the transport and nothing else may write to it.
// takeStdout() keeps the real stdout for the transport and points
// process.stdout.write at stderr, so the logger, the worker threads' forwarded
// stdout, a sandboxed module's console (the fs broker's console bridge) and any
// stray console.log land on stderr. framework.js calls it once, before anything
// logs; the transport writes through what it returns. A direct write to file
// descriptor 1 (fs.writeSync(1, ...), a child process inheriting stdio) is not
// covered: the pack's modules run under --moduleSandbox enforce, which routes
// their console through the broker and gives them no child processes.
let transport = null;
function takeStdout() {
  if (transport != null) return transport;
  const stdout = process.stdout;
  const realWrite = stdout.write.bind(stdout);
  stdout.write = (chunk, encoding, cb) => process.stderr.write(chunk, encoding, cb);
  transport = {
    write: (s, cb) => realWrite(s, cb),
    on: (event, fn) => stdout.on(event, fn)
  };
  return transport;
}

module.exports.takeStdout = takeStdout;
