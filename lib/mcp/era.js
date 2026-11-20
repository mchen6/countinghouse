'use strict';
// Which MCP era a request speaks, and the checks 2026-07-28 makes of a modern
// one (#229). From the revision's basic/versioning.md: "A request carrying
// modern per-request _meta is served statelessly according to this revision.
// An initialize request selects legacy semantics". So a request is modern
// when its params._meta carries the revision's protocolVersion or
// clientCapabilities key, or (over HTTP) its MCP-Protocol-Version header
// names a version that isn't a legacy one, and legacy otherwise: an
// initialize, and anything after it, behave as before this change. So a
// modern header can't be paired with a body that dodges the checks.
//
// A modern request must carry both keys ("A request missing any required
// field is malformed; the server MUST reject it with ... -32602"), name a
// version this server serves (-32022, data {supported, requested}), and over
// HTTP agree with its headers: MCP-Protocol-Version on every POST, Mcp-Method
// on every request, Mcp-Name on tools/call, resources/read, prompts/get and
// the tasks extension's tasks/get, tasks/update and tasks/cancel (M15)
// (-32020). Each of those is HTTP 400 (basic/transports/streamable-http.md).
// Notifications carry no required _meta and are not checked.

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
// The versions served per request, statelessly. A legacy client still gets
// its own version through initialize, which echoes it.
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28']);
// a named method -> the param its Mcp-Name header carries (M15 adds the
// tasks extension's three, named by their taskId)
const NAMED = {'tools/call': 'name', 'resources/read': 'uri', 'prompts/get': 'name', 'tasks/get': 'taskId', 'tasks/update': 'taskId', 'tasks/cancel': 'taskId'};
// the revisions with an initialize handshake, which a legacy client names in
// MCP-Protocol-Version after it (from 2025-06-18)
const LEGACY_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);

const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const metaOf = (req) => {
  const p = (req != null && req.params != null && typeof(req.params) === 'object') ? req.params : null;
  return (p != null && p._meta != null && typeof(p._meta) === 'object' && !Array.isArray(p._meta)) ? p._meta : null;
};

// a request (not a notification) speaking 2026-07-28. server/discover is
// always one: it exists only in this revision. headers: the HTTP request's,
// or null on stdio.
function isModern(req, headers) {
  if (req == null || typeof(req) !== 'object' || req.id === undefined || req.method === 'initialize') return false;
  if (req.method === 'server/discover') return true;
  const meta = metaOf(req);
  if (meta != null && (meta[VERSION_KEY] !== undefined || meta[CAPABILITIES_KEY] !== undefined)) return true;
  const headerVersion = headers != null ? headers['mcp-protocol-version'] : undefined;
  return typeof(headerVersion) === 'string' && !LEGACY_VERSIONS.has(headerVersion);
}

// The header value encoding: "=?base64?{Base64EncodedValue}?=" carries the
// UTF-8 of a value that isn't plain ASCII; the markers are case-sensitive.
const SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/;
function decodeHeaderValue(v) {
  if (typeof(v) !== 'string') return null;
  const m = SENTINEL.exec(v);
  return m == null ? v : Buffer.from(m[1], 'base64').toString('utf8');
}

const refusal = (code, message, data) => ({code, message, data});

// A modern request's problem -> {code, message, data?} or null. headers: the
// HTTP request's (lower-cased, as Node gives them), or null on stdio.
function checkModern(req, headers) {
  const meta = metaOf(req);
  const version = meta != null ? meta[VERSION_KEY] : undefined;
  const capabilities = meta != null ? meta[CAPABILITIES_KEY] : undefined;
  if (typeof(version) !== 'string' || version === '' || capabilities == null || typeof(capabilities) !== 'object' || Array.isArray(capabilities)) {
    return refusal(INVALID_PARAMS, `a ${SUPPORTED_VERSIONS[0]} request carries _meta["${VERSION_KEY}"] and _meta["${CAPABILITIES_KEY}"]`);
  }
  if (headers != null) {
    const headerVersion = headers['mcp-protocol-version'];
    if (headerVersion == null) return refusal(HEADER_MISMATCH, 'the MCP-Protocol-Version header is missing');
    if (headerVersion !== version) return refusal(HEADER_MISMATCH, 'the MCP-Protocol-Version header does not match the request\'s _meta protocol version');
    const method = headers['mcp-method'];
    if (method == null) return refusal(HEADER_MISMATCH, 'the Mcp-Method header is missing');
    if (decodeHeaderValue(method) !== req.method) return refusal(HEADER_MISMATCH, 'the Mcp-Method header does not match the request\'s method');
    if (Object.hasOwn(NAMED, req.method)) {
      const name = headers['mcp-name'];
      const p = req.params || {};
      const body = p[NAMED[req.method]];
      if (name == null) return refusal(HEADER_MISMATCH, 'the Mcp-Name header is missing');
      if (decodeHeaderValue(name) !== body) return refusal(HEADER_MISMATCH, 'the Mcp-Name header does not match the request\'s name');
    }
  }
  if (!SUPPORTED_VERSIONS.includes(version)) {
    return refusal(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {supported: SUPPORTED_VERSIONS.slice(), requested: version.slice(0, 64)});
  }
  return null;
}

module.exports = {isModern, checkModern, decodeHeaderValue, SUPPORTED_VERSIONS, VERSION_KEY, CAPABILITIES_KEY};
