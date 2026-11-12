// RC1-min: the main thread's client to one module's remote MCP server
// (spec section 4). One SDK Client over StreamableHTTPClientTransport, with
// lib/remote/fetch.js as its fetch, connected on first use and again after a
// failed connection. A result is returned exactly as the server sent it; a
// tool's isError is a result. Every failure is a CountinghouseError with a
// spec code, and no message carries the credential.
const http = require('http');
const https = require('https');
const path = require('path');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const {makeFetch, TOO_LARGE} = require('./fetch');

const SDK = path.dirname(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const {Client} = require(path.join(SDK, 'index.js'));
const {StreamableHTTPClientTransport, StreamableHTTPError} = require(path.join(SDK, 'streamableHttp.js'));
const {McpError, ErrorCode, CallToolResultSchema} = require(path.join(SDK, '..', 'types.js'));

const VERSION = require('../../package.json').version;
const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE']);

// The code for a failure, from what the SDK, the transport or our fetch
// threw.
function codeFor(e) {
  const cause = (e != null && e.cause != null) ? e.cause : null;
  if ((e && e.remoteCode) || (cause && cause.remoteCode)) return (e && e.remoteCode) || cause.remoteCode;
  if (e instanceof McpError) {
    if (e.data != null && e.data.marker === TOO_LARGE) return 'REMOTE_RESULT_TOO_LARGE';
    if (e.code === ErrorCode.RequestTimeout) return 'REMOTE_TIMEOUT';
    return 'REMOTE_PROTOCOL';
  }
  if (e instanceof StreamableHTTPError || (e && e.name === 'UnauthorizedError')) {
    const status = (e.code != null) ? e.code : 401;
    if (status === 401 || status === 403) return 'REMOTE_AUTH_FAILED';
    if (status >= 300 && status < 400) return 'REMOTE_UNREACHABLE';   // a redirect, refused
    if (status === 502 || status === 503) return 'REMOTE_UNREACHABLE';  // a gateway's outage, retryable
    if (status === 504) return 'REMOTE_TIMEOUT';
    return 'REMOTE_PROTOCOL';
  }
  const sys = (e && e.code) || (cause && cause.code);
  if (typeof(sys) === 'string' && (NETWORK.has(sys) || sys.startsWith('ERR_TLS') || sys.startsWith('CERT_') ||
      sys === 'DEPTH_ZERO_SELF_SIGNED_CERT' || sys === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || sys === 'SELF_SIGNED_CERT_IN_CHAIN')) {
    return 'REMOTE_UNREACHABLE';
  }
  return 'REMOTE_PROTOCOL';   // a body that is not JSON-RPC, a result that fails its schema
}

// A session the server no longer knows (404 to its Mcp-Session-Id) or a
// transport that closed: the next call connects again.
const lostSession = (e) => (e instanceof StreamableHTTPError && e.code === 404) || (e && /Not connected/.test(String(e.message)));

const MAX_PAGES = 100;

// remote: a parsed remote (declaration.js). credential: resolveCredential's
// {header, value, source}, or null. opts: {timeoutMs, maxBytes, debug,
// redisEndpoint, resolve? (dns.lookup's signature, for tests)}. timeoutMs is
// one deadline per call or listing, connecting included.
function createRemoteClient(remote, credential, opts) {
  const o = Object.assign({timeoutMs: 60000, maxBytes: 16 * 1024 * 1024}, opts);
  // The header's value and each long part of it ("Bearer <token>" and the
  // bare token, which a server may write back in an error body).
  const secrets = (credential == null) ? []
    : [credential.value].concat(credential.value.split(/\s+/).filter((part) => part.length >= 8));
  const headers = Object.assign({}, remote.headers);
  if (credential != null) headers[credential.header] = credential.value;
  const scrub = (text) => {
    let t = String(text);
    secrets.forEach((secret) => { t = t.split(secret).join('<credential>'); });
    return t.slice(0, 500);
  };
  // The client's own connections, which close() ends.
  const agent = new ((remote.url.protocol === 'https:') ? https : http).Agent({keepAlive: true});
  const timeoutError = () => Object.assign(new Error(`no answer within ${o.timeoutMs} ms`), {remoteCode: 'REMOTE_TIMEOUT'});
  const failure = (e) => {
    const code = codeFor(e);
    const detail = (code === 'REMOTE_AUTH_FAILED')
      ? `${remote.name} at ${remote.origin} answered ${(e && e.code) || 401}, with the credential from ${credential != null ? credential.source : 'no variable'}`
      : `${remote.name} at ${remote.origin}: ${scrub(e && e.message)}`;
    const err = new CountinghouseError(code, detail);
    err.stack = `${err.name}: ${err.message}`;   // no frame text from a message that held the credential
    return err;
  };

  let connected = null;   // Promise<Client> while connected or connecting
  const forget = (which) => {
    if (connected !== which || which == null) return;
    connected = null;
    which.then((client) => client.close(), () => {}).catch(() => {});
  };
  const connect = (ms) => {
    if (connected != null) return connected;
    const client = new Client({name: 'countinghouse', version: VERSION});
    client.onerror = () => {};   // a failure reaches the call that met it
    const transport = new StreamableHTTPClientTransport(remote.url, {
      fetch: makeFetch({maxBytes: o.maxBytes, timeoutMs: o.timeoutMs, agent: agent,
        debug: o.debug, redisEndpoint: o.redisEndpoint, resolve: o.resolve}),
      requestInit: {headers: headers}
    });
    const mine = client.connect(transport, {timeout: ms}).then(() => client, (e) => {
      if (connected === mine) connected = null;
      client.close().catch(() => {});
      throw e;
    });
    client.onclose = () => { if (connected === mine) connected = null; };
    connected = mine;
    return mine;
  };
  // One deadline for the whole operation: connecting (or waiting for a
  // connection another call started) and every request after it.
  const run = async (fn) => {
    const deadline = Date.now() + o.timeoutMs;
    const left = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw timeoutError();
      return ms;
    };
    let timer = null;
    const expired = new Promise((resolve, reject) => { timer = setTimeout(() => reject(timeoutError()), o.timeoutMs); });
    let which = null;
    try {
      return await Promise.race([expired, (async () => {
        which = connect(left());
        const client = await which;
        return fn(client, left);
      })()]);
    } catch (e) {
      if (lostSession(e)) forget(which);
      throw failure(e);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    // Every tool, following nextCursor: [{name, inputSchema}].
    // A cursor seen before, or more than MAX_PAGES pages, is REMOTE_PROTOCOL.
    list: () => run(async (client, left) => {
      const tools = [];
      const seen = new Set();
      let cursor;
      do {
        if (seen.size >= MAX_PAGES) throw new Error(`tools/list went past ${MAX_PAGES} pages`);
        const page = await client.listTools(cursor != null ? {cursor: cursor} : undefined, {timeout: left()});
        page.tools.forEach((t) => tools.push({name: t.name, inputSchema: t.inputSchema}));
        cursor = page.nextCursor;
        if (cursor != null && seen.has(cursor)) throw new Error(`tools/list repeated the cursor ${JSON.stringify(cursor).slice(0, 64)}`);
        if (cursor != null) seen.add(cursor);
      } while (cursor != null);
      return tools;
    }),
    // The CallToolResult as the server sent it.
    call: (tool, args) => run((client, left) => client.request({method: 'tools/call', params: {name: tool, arguments: args}},
      CallToolResultSchema, {timeout: left()})),
    close: async () => {
      const c = connected;
      connected = null;
      if (c != null) await c.then((client) => client.close(), () => {});
      agent.destroy();
    }
  };
}

module.exports = {createRemoteClient, codeFor};
