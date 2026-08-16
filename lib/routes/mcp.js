// MCP gateway route: stateless Streamable HTTP transport only, per the
// 2026-07-28 spec. The deprecated HTTP+SSE transport (separate GET stream +
// Mcp-Session-Id-based session state) is intentionally not implemented --
// every request is self-contained, so GET (the old transport's stream
// upgrade) is just rejected below.
const express = require('express');
const async   = require('async');
const gateway = require('../mcp/gateway');
const LOG     = require('../logger');

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    res.setHeader('MCP-Protocol-Version', gateway.PROTOCOL_VERSION);

    const body = req.body;
    if (body == null || (typeof(body) !== 'object')) {
      return res.status(400).json(gateway.errorResponse(null, gateway.JSONRPC_PARSE_ERROR, 'request body must be a JSON-RPC 2.0 object or batch array'));
    }

    const appKey = req.headers['x-ch-key'] || null;
    const isBatch = Array.isArray(body);
    const messages = isBatch ? body : [body];

    async.mapSeries(messages, (message, cb) => {
      gateway.handle(message, cdifInterface, appKey, cb);
    }, (err, results) => {
      if (err) {
        return res.status(500).json(gateway.errorResponse(null, -32603, err.message || String(err)));
      }

      const responses = results.filter((r) => { return r != null; });

      if (responses.length === 0) {
        // every message was a notification -- MCP Streamable HTTP transport
        // requires no body in this case.
        return res.status(202).end();
      }

      res.status(200).json(isBatch ? responses : responses[0]);
    });
  });

  // stateless transport: no server-initiated SSE stream, so the optional GET
  // upgrade from the legacy transport is not supported here.
  router.route('/').get((req, res) => {
    res.status(405).json({topic: 'countinghouse error', message: 'this MCP gateway only implements the stateless Streamable HTTP transport (POST /mcp); GET/SSE is not supported'});
  });

  return router;
};
