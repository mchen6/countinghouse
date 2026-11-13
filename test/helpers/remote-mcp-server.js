// A local streamable-HTTP MCP server for RC1-min's tests (lib/remote/): the
// SDK's own server, stateless, one transport per request. It records the
// headers of every request and counts connections, and answers with the
// tools below, or misbehaves on purpose with `mode`.
//
//   echo_text   {content: [{type: 'text', text: JSON of the arguments}]}
//   fails       an isError result with GitHub's "410" text
//   structured  content plus structuredContent
//   mixed       a text block and an image block (called, not listed)
//   big         one text item of 17 MiB, as JSON
//   big_sse     the same, as an event stream
//   sse_text    echo_text's answer, as an event stream
//   slow        echo_text's answer after 3 s
//
// mode: 'ok' (default), '401' (every request), 'garbage' (200 with a body
// that is not JSON-RPC), 'redirect' (302 to `redirectTo`), 'paged'
// (tools/list in pages of two), 'loopcursor' (every page names cursor "0"
// next), '600', '404', '500', '503', '504' (that status on every
// request), 'echo400' (400 whose body repeats the Authorization header's
// token), 'slowall' (every request answered after 600 ms).
const http = require('http');
const path = require('path');
// The SDK copy lib/remote/client.js loads, found the same way.
const SDK = path.dirname(path.dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {Server} = require(path.join(SDK, 'server', 'index.js'));
const {StreamableHTTPServerTransport} = require(path.join(SDK, 'server', 'streamableHttp.js'));
const {ListToolsRequestSchema, CallToolRequestSchema} = require(path.join(SDK, 'types.js'));

const BIG = 17 * 1024 * 1024;
const TOOLS = ['echo_text', 'fails', 'structured', 'big', 'big_sse', 'sse_text', 'slow'];
const SSE_TOOLS = new Set(['big_sse', 'sse_text']);
const tool = (name) => ({name: name, inputSchema: {type: 'object'}});

function answer(name, args) {
  const text = JSON.stringify(args != null ? args : {});
  switch (name) {
    case 'echo_text':
    case 'sse_text': return {content: [{type: 'text', text: text}]};
    case 'fails': return {content: [{type: 'text', text: 'failed to get job logs: unexpected status code: 410 Gone'}], isError: true};
    case 'structured': return {content: [{type: 'text', text: '{"n":3}'}], structuredContent: {n: 3}};
    case 'mixed': return {content: [{type: 'text', text: 'ab\ncd'}, {type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png'}]};
    case 'big':
    case 'big_sse': return {content: [{type: 'text', text: 'x'.repeat(BIG)}]};
    case 'slow': return new Promise((resolve) => setTimeout(() => resolve({content: [{type: 'text', text: text}]}), 3000));
    default: return {content: [{type: 'text', text: `no tool ${name}`}], isError: true};
  }
}

// -> Promise<{headers: [object], paths: [request path], calls: [tool name], connections(): number,
// open(): number, sockets(): Set of the open ones, close(): Promise,
// setMode(mode), extraTools: []}>
function startRemoteServer(port, opts) {
  const o = Object.assign({mode: 'ok', redirectTo: null}, opts);
  const state = {headers: [], paths: [], calls: [], connections: 0, open: 0, sockets: new Set(), mode: o.mode, extraTools: []};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      state.headers.push(req.headers);
      state.paths.push(req.url);
      if (state.mode === '401') { res.writeHead(401, {'content-type': 'text/plain'}); return res.end('unauthorized'); }
      if (state.mode === 'redirect') { res.writeHead(302, {location: o.redirectTo}); return res.end(); }
      if (state.mode === 'garbage') { res.writeHead(200, {'content-type': 'application/json'}); return res.end('not json'); }
      if (/^\d{3}$/.test(state.mode)) { res.writeHead(Number(state.mode), {'content-type': 'text/plain'}); return res.end('status'); }
      if (state.mode === 'echo400') {
        res.writeHead(400, {'content-type': 'text/plain'});
        return res.end(`invalid token ${String(req.headers.authorization || '').split(' ').pop()}`);
      }
      if (state.mode === 'slowall') await new Promise((resolve) => setTimeout(resolve, 600));
      let message = null;
      try { message = body !== '' ? JSON.parse(body) : undefined; } catch (e) { res.writeHead(400); return res.end(); }
      const callName = (message != null && message.method === 'tools/call' && message.params != null) ? message.params.name : null;
      if (callName != null) state.calls.push(callName);
      const s = new Server({name: 'remote-test', version: '1.0.0'}, {capabilities: {tools: {}}});
      s.setRequestHandler(ListToolsRequestSchema, async (r) => {
        const all = TOOLS.concat(state.extraTools).map(tool);
        if (state.mode === 'loopcursor') return {tools: all.slice(0, 1), nextCursor: '0'};
        if (state.mode !== 'paged') return {tools: all};
        const at = (r.params != null && r.params.cursor != null) ? Number(r.params.cursor) : 0;
        const page = {tools: all.slice(at, at + 2)};
        if (at + 2 < all.length) page.nextCursor = String(at + 2);
        return page;
      });
      s.setRequestHandler(CallToolRequestSchema, async (r) => answer(r.params.name, r.params.arguments));
      const t = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: !SSE_TOOLS.has(callName)});
      await s.connect(t);
      res.on('close', () => { t.close(); s.close(); });
      t.handleRequest(req, res, message);
    });
  });
  server.on('connection', (socket) => {
    state.connections += 1;
    state.open += 1;
    state.sockets.add(socket);
    socket.on('close', () => { state.open -= 1; state.sockets.delete(socket); });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      headers: state.headers,
      paths: state.paths,
      calls: state.calls,
      connections: () => state.connections,
      open: () => state.open,
      sockets: () => new Set(state.sockets),
      setMode: (mode) => { state.mode = mode; },
      extraTools: state.extraTools,
      close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); })
    }));
  });
}

module.exports = {startRemoteServer, BIG};
