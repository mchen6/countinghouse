#!/usr/bin/env node
'use strict';
// The "separate server" of the maintainer's latency gate (perf/latency-gate/README.md):
// the MCP SDK's own Server over stdio with the same tool, the same work and
// the same output as perf-time's get_current_time.
const path = require('path');
const SDK = path.dirname(path.dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {Server} = require(path.join(SDK, 'server', 'index.js'));
const {StdioServerTransport} = require(path.join(SDK, 'server', 'stdio.js'));
const {ListToolsRequestSchema, CallToolRequestSchema} = require(path.join(SDK, 'types.js'));

const s = new Server({name: 'plain-time', version: '0'}, {capabilities: {tools: {}}});
s.setRequestHandler(ListToolsRequestSchema, async () => ({tools: [{name: 'get_current_time', description: 'The current time in an IANA timezone.',
  inputSchema: {type: 'object', properties: {timezone: {type: 'string'}}, required: ['timezone']}}]}));
s.setRequestHandler(CallToolRequestSchema, async (r) => {
  const tz = r.params.arguments.timezone;
  const out = {timezone: tz, datetime: new Date().toLocaleString('sv-SE', {timeZone: tz})};
  return {content: [{type: 'text', text: JSON.stringify(out)}], structuredContent: out};
});
s.connect(new StdioServerTransport());
