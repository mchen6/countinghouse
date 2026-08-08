// MCP JSON-RPC 2.0 method dispatch. Transport-agnostic on purpose -- lib/routes/mcp.js
// is the only thing that knows this is running over stateless Streamable HTTP; this
// file just takes a parsed JSON-RPC request object and a callback.
var userAuth     = require('../user-auth');
var toolRegistry = require('./tool-registry');

var PROTOCOL_VERSION = '2026-07-28';
var SERVER_NAME      = 'countinghouse';
var SERVER_VERSION   = require('../../package.json').version;

var JSONRPC_PARSE_ERROR      = -32700;
var JSONRPC_INVALID_REQUEST  = -32600;
var JSONRPC_METHOD_NOT_FOUND = -32601;
var JSONRPC_INVALID_PARAMS   = -32602;
var JSONRPC_INTERNAL_ERROR   = -32603;

function errorResponse(id, code, message) {
  return {jsonrpc: '2.0', id: (id === undefined ? null : id), error: {code: code, message: message}};
}

function resultResponse(id, result) {
  return {jsonrpc: '2.0', id: id, result: result};
}

// This server's request/response handling has no version-specific branches --
// tools/list and tools/call are shaped the same way regardless of which
// protocolVersion the client negotiates. So instead of unilaterally forcing
// our own preferred version and refusing anything else, we echo back whatever
// version the client asked for in its `initialize` call: cheap to support,
// and it keeps us working with clients built against slightly different spec
// dates without a hardcoded compatibility table to maintain.
function handleInitialize(req, cdifInterface, callback) {
  var params = req.params || {};
  var negotiatedVersion = (typeof(params.protocolVersion) === 'string' && params.protocolVersion !== '')
    ? params.protocolVersion
    : PROTOCOL_VERSION;

  return callback(null, resultResponse(req.id, {
    protocolVersion: negotiatedVersion,
    capabilities: {
      tools: {}
    },
    serverInfo: {
      name:    SERVER_NAME,
      version: SERVER_VERSION
    }
  }));
}

function handlePing(req, cdifInterface, callback) {
  return callback(null, resultResponse(req.id, {}));
}

function handleToolsList(req, cdifInterface, appKey, callback) {
  toolRegistry.buildToolList(cdifInterface, appKey, function(err, tools) {
    if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    return callback(null, resultResponse(req.id, {tools: tools}));
  });
}

function handleToolsCall(req, cdifInterface, appKey, callback) {
  var params = req.params || {};
  var name      = params.name;
  var toolArgs  = params.arguments || {};

  if (typeof(name) !== 'string' || name === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.name must be a non-empty string'));
  }

  var targets = toolRegistry.buildToolTargets(cdifInterface);
  var target  = targets[name];

  if (target == null) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'unknown tool: ' + name));
  }

  var args = {input: toolArgs};

  userAuth(null, null, target.deviceID, appKey, target.serviceID, target.actionName, function(err, data) {
    if (err != null) {
      return callback(null, resultResponse(req.id, {
        isError: true,
        content: [{type: 'text', text: (err.message != null ? err.message : String(err))}]
      }));
    }
    return callback(null, resultResponse(req.id, {
      isError: false,
      content: [{type: 'text', text: JSON.stringify(data == null ? {} : data)}],
      structuredContent: (data == null ? {} : data)
    }));
  }, function(err, session) {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }
    session.localInput = args;
    cdifInterface.invokeDeviceAction(target.deviceID, target.serviceID, target.actionName, args, null, session);
  });
}

// notifications (no `id`) never get a response -- per JSON-RPC 2.0 and MCP's
// Streamable HTTP transport, the server MUST NOT write a body for these.
var NOTIFICATION_METHODS = {
  'notifications/initialized': true
};

// handles exactly one JSON-RPC request/notification object. batching (an array
// of these) is handled by the route layer, which calls this once per entry.
function handle(req, cdifInterface, appKey, callback) {
  if (req == null || typeof(req) !== 'object' || req.jsonrpc !== '2.0' || typeof(req.method) !== 'string') {
    return callback(null, errorResponse(req && req.id, JSONRPC_INVALID_REQUEST, 'invalid JSON-RPC 2.0 request'));
  }

  if (NOTIFICATION_METHODS[req.method] === true) {
    return callback(null, null); // no response for notifications
  }

  switch (req.method) {
    case 'initialize': return handleInitialize(req, cdifInterface, callback);
    case 'ping':        return handlePing(req, cdifInterface, callback);
    case 'tools/list':  return handleToolsList(req, cdifInterface, appKey, callback);
    case 'tools/call':  return handleToolsCall(req, cdifInterface, appKey, callback);
    default:
      return callback(null, errorResponse(req.id, JSONRPC_METHOD_NOT_FOUND, 'method not found: ' + req.method));
  }
}

module.exports = {
  handle: handle,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  JSONRPC_PARSE_ERROR: JSONRPC_PARSE_ERROR,
  errorResponse: errorResponse
};
