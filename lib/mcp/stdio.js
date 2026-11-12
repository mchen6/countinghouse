// The --stdio route layer (local-mode spec §2): the MCP gateway's handle()
// served over newline-delimited JSON-RPC instead of HTTP. One request per
// line on the input, one response per line on the output, batches answered
// as lib/routes/mcp.js answers them (one handle per entry, in order, the
// notifications dropped), notifications answered with nothing. Requests run
// concurrently and each response is one write, so lines never interleave.
// When the input ends, no new line is read and the calls in flight are
// drained, up to drainMs; then `done` resolves 0, or 1 when the drain ran out.
//
// It knows nothing of the server: `handle(message, appKey, cb)` is the
// gateway's handle with the interface bound, so the layer is tested over two
// in-memory streams. Logging is not its business either: under --stdio the
// output stream is the transport and the logger writes to stderr.

const JSONRPC_PARSE_ERROR     = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_INTERNAL_ERROR  = -32603;

const error = (id, code, message) => ({jsonrpc: '2.0', id: id === undefined ? null : id, error: {code, message}});
const idOf = (message) => (message != null && typeof message === 'object' && !Array.isArray(message) ? message.id : null);

function serveStdio({input, output, handle, appKey, drainMs}) {
  let buffer = '';
  let ended = false;
  let inFlight = 0;
  let drained = null;

  const write = (response) => { output.write(`${JSON.stringify(response)  }\n`); };

  const settled = () => {
    inFlight -= 1;
    if (ended && inFlight === 0 && drained != null) drained();
  };

  // One message -> its response, or null for a notification.
  const one = (message) => new Promise((resolve) => {
    try {
      handle(message, appKey, (err, response) => resolve(err != null ? error(idOf(message), JSONRPC_INTERNAL_ERROR, 'internal error') : response));
    } catch (_) {
      resolve(error(idOf(message), JSONRPC_INTERNAL_ERROR, 'internal error'));
    }
  });

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

  const read = (chunk) => {
    if (ended) return;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      serveLine(line);
    }
  };

  const done = new Promise((resolve) => {
    input.on('end', () => {
      // The last line may have no newline of its own.
      if (buffer !== '') { const last = buffer.replace(/\r$/, ''); buffer = ''; serveLine(last); }
      ended = true;
      if (inFlight === 0) return resolve(0);
      const timer = setTimeout(() => resolve(1), drainMs);
      drained = () => { clearTimeout(timer); resolve(0); };
    });
  });

  input.setEncoding('utf8');
  input.on('data', read);
  return {done};
}

module.exports = {serveStdio};

// Under --stdio, stdout is the transport and nothing else may write to it.
// takeStdout() keeps the real stdout for the transport and points
// process.stdout.write at stderr, so the logger, a module's console (through
// the fs broker's console bridge and the worker threads' forwarded stdout) and
// any stray console.log land on stderr. framework.js calls it once, before
// anything logs; the transport writes through what it returns.
let transport = null;
function takeStdout() {
  if (transport != null) return transport;
  const stdout = process.stdout;
  const realWrite = stdout.write.bind(stdout);
  stdout.write = (chunk, encoding, cb) => process.stderr.write(chunk, encoding, cb);
  transport = {write: (s) => realWrite(s)};
  return transport;
}

module.exports.takeStdout = takeStdout;
