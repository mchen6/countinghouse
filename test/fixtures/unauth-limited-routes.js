'use strict';
// Run by test/auth/59 in a child process (part of test/auth/59): the real
// REST routes and the real MCP gateway behind /mcp, with lib/user-auth
// stubbed to answer every lookup UNAUTH_RATE_LIMITED -- an address that went
// over its budget while the request was under way. Prints, per request, the
// status, the Retry-After and the body.
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '../..');
const {CountinghouseError} = require(path.join(ROOT, 'lib/countinghouse-error'));
require(path.join(ROOT, 'lib/cli-options')).setOptions({});
require.cache[require.resolve(path.join(ROOT, 'lib/user-auth'))] = {
  id: 'user-auth-stub', loaded: true,
  exports: (req, res, deviceID, appKey, serviceID, actionName, localCB, callback) => callback(new CountinghouseError('UNAUTH_RATE_LIMITED'))
};
const express = require('express');
const app = express();
app.use(express.json());
const cdif = {deviceManager: {getAllDeviceSpecs: () => ({})}};
app.use('/balance', require(path.join(ROOT, 'lib/routes/balance'))(null, cdif));
app.use('/device-list', require(path.join(ROOT, 'lib/routes/device-list'))(null, cdif));
app.post('/admin', require(path.join(ROOT, 'lib/routes/admin-only')), (req, res) => res.json({ran: true}));
app.post('/devices/:deviceID/invoke-action', require(path.join(ROOT, 'lib/routes/user')), (req, res) => res.json({ran: true}));
app.use('/mcp', require(path.join(ROOT, 'lib/routes/mcp'))(null, cdif, null, {}));

const server = app.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const send = (method, p, body) => new Promise((resolve) => {
    const data = body != null ? JSON.stringify(body) : null;
    const rq = http.request({host: '127.0.0.1', port, path: p, method,
      headers: Object.assign({'X-CH-Key': 'some-key', 'Accept': 'application/json, text/event-stream'}, data != null ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)} : {})}, (r) => {
      let t = '';
      r.on('data', (c) => { t += c; });
      r.on('end', () => resolve({path: p, status: r.statusCode, retryAfter: r.headers['retry-after'] || null, body: t}));
    });
    rq.on('error', (e) => resolve({path: p, error: e.message}));
    rq.end(data);
  });
  const out = [];
  out.push(await send('GET', '/balance'));
  out.push(await send('GET', '/device-list'));
  out.push(await send('POST', '/admin', {}));
  out.push(await send('POST', '/devices/x/invoke-action', {serviceID: 's', actionName: 'a'}));
  out.push(await send('POST', '/mcp', {jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name: 'any_tool', arguments: {}}}));
  out.push(await send('POST', '/mcp', [{jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name: 'any_tool', arguments: {}}}]));
  process.stdout.write(JSON.stringify(out));
  server.close();
  process.exit(0);
});
