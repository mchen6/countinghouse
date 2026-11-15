// MCP gateway route: stateless Streamable HTTP transport only, per the
// 2026-07-28 spec. The deprecated HTTP+SSE transport (separate GET stream +
// Mcp-Session-Id-based session state) is intentionally not implemented --
// every request is self-contained, so GET (the old transport's stream
// upgrade) is just rejected below.
const express = require('express');
const async   = require('async');
const gateway = require('../mcp/gateway');
const era     = require('../mcp/era');
const LOG     = require('../logger');

// An SSE comment every KEEP_ALIVE_MS on an open subscriptions/listen stream
// ("encouraged to periodically emit an SSE comment line"), so a proxy or a
// client's idle timer keeps it.
const KEEP_ALIVE_MS = 25000;

// subscriptions: the hub of subscriptions/listen streams (lib/mcp/
// subscriptions.js), or none, and then listen is an unknown method here.
module.exports = function(mm, cdifInterface, subscriptions) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    res.setHeader('MCP-Protocol-Version', gateway.PROTOCOL_VERSION);

    const body = req.body;
    if (body == null || (typeof(body) !== 'object')) {
      return res.status(400).json(gateway.errorResponse(null, gateway.JSONRPC_PARSE_ERROR, 'request body must be a JSON-RPC 2.0 object or batch array'));
    }

    const appKey = req.headers['x-ch-key'] || null;
    const isBatch = Array.isArray(body);
    // 2026-07-28 (#229): "The body of the HTTP POST MUST be a single JSON-RPC
    // request or notification", checked against its headers. A batch stays
    // the legacy path's.
    if (!isBatch) {
      // subscriptions/listen answers as an SSE stream that stays open: its
      // acknowledgement and notifications as events, then its result when it
      // ends gracefully. Its close (the client's) is the cancel.
      let stream = null;
      let keepAlive = null;
      const event = (m) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(m)}\n\n`); };
      const openStream = () => {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        keepAlive = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n'); }, KEEP_ALIVE_MS);
        if (typeof(keepAlive.unref) === 'function') keepAlive.unref();
        // a client that left while its key was being checked has closed
        // already: its close runs at once, so it holds no slot
        const gone = () => res.destroyed || (req.socket != null && req.socket.destroyed);
        stream = {write: event, onClose: (fn) => {
          const closed = () => { clearInterval(keepAlive); fn(); };
          if (gone()) return setImmediate(closed);
          return res.on('close', closed);
        }};
        return stream;
      };
      return gateway.handle(body, cdifInterface, appKey, (err, response, info) => {
        if (stream != null) {
          clearInterval(keepAlive);
          if (err == null && response != null) event(response);
          return res.end();
        }
        if (err) return res.status(500).json(gateway.errorResponse(null, -32603, err.message || String(err)));
        if (response == null) return res.status(202).end();
        res.status((info != null && info.status != null) ? info.status : 200).json(response);
      }, {headers: req.headers, subscriptions: subscriptions, openStream: subscriptions != null ? openStream : undefined});
    }
    if (body.some((m) => era.isModern(m, req.headers))) {
      return res.status(400).json(gateway.errorResponse(null, gateway.JSONRPC_INVALID_REQUEST, 'a 2026-07-28 request is sent one per POST, never in a batch'));
    }
    const messages = body;

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
    res.status(405).json({message: 'this MCP gateway only implements the stateless Streamable HTTP transport (POST /mcp); GET/SSE is not supported'});
  });

  return router;
};
