// A stub of GitHub's MCP server for perf/shared-runtime/measure.js: the SDK's
// own server, stateless Streamable HTTP, on loopback, answering the tools pack
// 1's ch-access-github calls (lib/remote.js there) with canned bodies in
// GitHub's shapes: one failed run, one failed job, a 200-line log, the run's
// commit. The runtime reaches it through --remoteOriginMap (acceptance only),
// so a call runs the REAL ch-access-github and the runtime's remote path (the
// main thread's outbound MCP call, its credential injection, its response
// cap), with no network and no --debug.
'use strict';
const http = require('http');
const path = require('path');
const SDK = path.dirname(path.dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {Server} = require(path.join(SDK, 'server', 'index.js'));
const {StreamableHTTPServerTransport} = require(path.join(SDK, 'server', 'streamableHttp.js'));
const {ListToolsRequestSchema, CallToolRequestSchema} = require(path.join(SDK, 'types.js'));

const SHA = '4f1c2e9a7b3d5f60a8e9c1b2d3f4a5b6c7d8e9f0';

function log() {
  const lines = [];
  for (let i = 0; i < 200; i++) {
    const t = `2026-11-14T10:00:${String(i % 60).padStart(2, '0')}.000Z`;
    if (i === 120 || i === 121) lines.push(`${t} Error: expected 3 to equal 4 (test/unit/widget.test.js:${40 + i})`);
    else if (i === 150) lines.push('2026-11-14T10:02:30.000Z npm ERR! code ELIFECYCLE');
    else lines.push(`${t} step output line ${i}`);
  }
  return `${lines.join('\n')}\n`;
}
const LOG = log();

const BODIES = {
  list_workflow_runs: () => ({total_count: 1, workflow_runs: [{id: 1234567890, conclusion: 'failure', head_sha: SHA, head_branch: 'main',
    created_at: '2026-11-14T10:00:00Z', name: 'CI', html_url: 'https://github.example/acme/widgets/actions/runs/1234567890'}]}),
  list_workflow_jobs: () => ({jobs: {total_count: 1, jobs: [{id: 9876543210, name: 'test (24)', conclusion: 'failure',
    steps: [{name: 'Install', conclusion: 'success'}, {name: 'Test', conclusion: 'failure'}]}]}}),
  get_job_logs: () => ({logs_content: LOG, original_length: 200}),
  list_commits: () => [{sha: SHA, author: {login: 'octo-dev'}}]
};
const TOOLS = ['actions_list', 'get_job_logs', 'list_commits'];

function answer(name, args) {
  const which = (name === 'actions_list') ? (args && args.method) : name;
  const body = BODIES[which];
  if (body == null) return {content: [{type: 'text', text: `stub: no answer for ${String(which).slice(0, 64)}`}], isError: true};
  return {content: [{type: 'text', text: JSON.stringify(body())}]};
}

// -> Promise of {port, close(), calls}: listening on 127.0.0.1, an OS-chosen port.
function startGithubStub() {
  const state = {calls: 0};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const mcp = new Server({name: 'github-stub', version: '0.0.0'}, {capabilities: {tools: {}}});
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({tools: TOOLS.map((n) => ({name: n, inputSchema: {type: 'object'}}))}));
      mcp.setRequestHandler(CallToolRequestSchema, async (r) => { state.calls++; return answer(r.params.name, r.params.arguments); });
      const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
      res.on('close', () => { transport.close(); mcp.close(); });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body === '' ? undefined : JSON.parse(body));
      } catch (e) {
        if (!res.headersSent) { res.statusCode = 400; res.end(); }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({port: server.address().port, calls: state, close: () => server.close()})));
}

module.exports = {startGithubStub};
