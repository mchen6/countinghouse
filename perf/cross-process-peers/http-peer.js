// JSON-RPC 2.0 echo peer over localhost HTTP -- same do-nothing body as the
// stdio peer, so the two differ only in transport.
const http = require('http');

const port = parseInt(process.argv[2], 10);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { parsed = {}; }
    const out = JSON.stringify({
      jsonrpc: '2.0',
      id: parsed.id,
      result: {echo: parsed.params != null ? parsed.params.payload : null}
    });
    res.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(out)});
    res.end(out);
  });
});

// keep-alive on, matching what any real JSON-RPC-over-HTTP client would get;
// measuring connection setup per call would be measuring the wrong thing.
server.keepAliveTimeout = 60000;
server.listen(port, '127.0.0.1', () => { process.send ? process.send('ready') : console.log('ready'); });
