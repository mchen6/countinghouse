// Newline-delimited JSON-RPC 2.0 echo peer over stdio -- the framing MCP's
// stdio transport uses (one JSON object per line on stdin/stdout).
// Deliberately minimal: it does nothing but parse, echo and serialize, so
// what the benchmark measures is transport cost and not tool work.
let buf = '';

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === '') continue;

    let req;
    try { req = JSON.parse(line); } catch (e) { continue; }

    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {echo: req.params != null ? req.params.payload : null}
    })  }\n`);
  }
});

process.stdin.resume();
