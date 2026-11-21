'use strict';
// RC1-min: the main thread's client to one module's remote MCP server
// (spec section 4). One SDK Client over StreamableHTTPClientTransport, with
// lib/remote/fetch.js as its fetch, connected on first use and again after a
// failed connection. A result is returned exactly as the server sent it; a
// tool's isError is a result. Every failure is a CountinghouseError with a
// spec code, and no message carries the credential.
const http = require('http');
const https = require('https');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const {makeFetch, TOO_LARGE} = require('./fetch');

// The MCP SDK, loaded on first use: only a module that declares a remote
// needs it, and loading it at require time resolved the SDK's package.json
// on every module's load path, which --hardened refuses where the install
// keeps the SDK outside the read grants (a hoisted or symlinked
// node_modules; fs-broker 14).
let sdkCache = null;
function sdk() {
  if (sdkCache == null) {
    const {Client} = require('@modelcontextprotocol/sdk/client/index.js');
    const {StreamableHTTPClientTransport, StreamableHTTPError} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const {McpError, ErrorCode, CallToolResultSchema, ResultSchema} = require('@modelcontextprotocol/sdk/types.js');
    sdkCache = {Client, StreamableHTTPClientTransport, StreamableHTTPError, McpError, ErrorCode, CallToolResultSchema, ResultSchema};
  }
  return sdkCache;
}

const VERSION = require('../../package.json').version;
const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE']);

// The code for a failure, from what the SDK, the transport or our fetch
// threw.
function codeFor(e) {
  const {McpError, ErrorCode, StreamableHTTPError} = sdk();
  const cause = (e != null && e.cause != null) ? e.cause : null;
  if ((e && e.remoteCode) || (cause && cause.remoteCode)) return (e && e.remoteCode) || cause.remoteCode;
  if (e instanceof McpError) {
    if (e.data != null && e.data.marker === TOO_LARGE) return 'REMOTE_RESULT_TOO_LARGE';
    if (e.code === ErrorCode.RequestTimeout) return 'REMOTE_TIMEOUT';
    // The client was closed under the call: the module was unloaded or
    // reloaded, or the connection ended.
    if (e.code === ErrorCode.ConnectionClosed) return 'REMOTE_UNREACHABLE';
    return 'REMOTE_PROTOCOL';
  }
  if (e instanceof StreamableHTTPError || (e && e.name === 'UnauthorizedError')) {
    const status = (e.code != null) ? e.code : 401;
    if (status === 401 || status === 403) return 'REMOTE_AUTH_FAILED';
    if (status >= 300 && status < 400) return 'REMOTE_UNREACHABLE';   // a redirect to another origin (or past 5), refused
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
const lostSession = (e) => (e instanceof sdk().StreamableHTTPError && e.code === 404) || (e && /Not connected/.test(String(e.message)));

const MAX_PAGES = 100;
// A listing's bounds (the reviewer's pre-work high on #508, F3): at most
// MAX_TOOLS tools and MAX_LISTING_CHARS characters of their JSON in all, or
// the listing is REMOTE_PROTOCOL, naming the bound. A page's count is
// checked before any of its tools is looked at; the SDK's listTools, which
// compiles every outputSchema with Ajv on main, is never used.
const MAX_TOOLS = 2048;
const MAX_LISTING_CHARS = 4 * 1024 * 1024;
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const {line} = require('../module-text');
// The credential as a pattern that also matches it after the cleaner made
// its whitespace or a hidden character into spaces: each character, then
// any run of spaces (F8)
const spread = (secret) => new RegExp(Array.from(secret.replace(/\s+/g, ''))
  .map((ch) => ch.replace(/[\\^$.*+?()[\]{}|\/-]/g, '\\$&')).join(' *'), 'g');
const SCRUB_MAX = 500;

// remote: a parsed remote (declaration.js). credential: resolveCredential's
// {header, value, source}, or null. opts: {timeoutMs, maxBytes, debug,
// redisEndpoint, resolve? (dns.lookup's signature, for tests)}. timeoutMs is
// one deadline per call or listing, connecting included.
// The Redis endpoint --redisUrl names, for a client given none: the
// resolved-address check fails closed rather than off.
function configuredRedis() {
  const options = require('../cli-options');
  try {
    // (the runtime's default, as lib/cli-options.js has it: never exported there)
    const u = new URL(options.redisUrl || 'redis://127.0.0.1:6379');
    return {host: u.hostname || '127.0.0.1', port: (u.port !== '') ? Number(u.port) : 6379};
  } catch (e) {
    return {host: '127.0.0.1', port: 6379};
  }
}

function createRemoteClient(remote, credential, opts) {
  const {Client, StreamableHTTPClientTransport, CallToolResultSchema, ResultSchema} = sdk();
  const o = Object.assign({timeoutMs: 60000, maxBytes: 16 * 1024 * 1024}, opts);
  if (o.redisEndpoint === undefined) o.redisEndpoint = configuredRedis();
  o.debug = (o.debug === true);
  // The header's value and each long part of it ("Bearer <token>" and the
  // bare token, which a server may write back in an error body).
  const secrets = (credential == null) ? []
    : [credential.value].concat(credential.value.split(/\s+/).filter((part) => part.length >= 8));
  const headers = Object.assign({}, remote.headers);
  if (credential != null) headers[credential.header] = credential.value;
  // (F8: the exact value replaced first, then the text cleaned as the
  // module-text cleaner cleans it -- every hidden character a space, runs of
  // spaces one -- and the value replaced again however its spaces came out;
  // cut to SCRUB_MAX only after, from a bounded room that holds any value
  // starting before the cut)
  const patterns = secrets.map(spread);
  const longest = secrets.reduce((n, s) => Math.max(n, s.length), 0);
  const scrub = (text) => {
    let t = String(text).slice(0, SCRUB_MAX * 4 + longest * 2);
    secrets.forEach((secret) => { t = t.split(secret).join('<credential>'); });
    if (patterns.length > 0) {
      t = line(t).replace(/ {2,}/g, ' ');
      patterns.forEach((p) => { t = t.replace(p, '<credential>'); });
    }
    return t.slice(0, SCRUB_MAX);
  };
  // The client's own connections, which close() ends.
  const agent = new ((remote.url.protocol === 'https:') ? https : http).Agent({keepAlive: true});
  const timeoutError = () => Object.assign(new Error(`no answer within ${o.timeoutMs} ms`), {remoteCode: 'REMOTE_TIMEOUT'});
  const failure = (e) => {
    const code = codeFor(e);
    const detail = (code === 'REMOTE_AUTH_FAILED')
      ? `${remote.name} at ${remote.shown || remote.origin} answered ${(e && e.code) || 401}, with the credential from ${credential != null ? credential.source : 'no variable'}`
      : `${remote.name} at ${remote.shown || remote.origin}: ${scrub(e && e.message)}`;
    const err = new CountinghouseError(code, detail);
    err.stack = `${err.name}: ${err.message}`;   // no frame text from a message that held the credential
    return err;
  };

  let connected = null;   // Promise<Client> while connected or connecting
  let closed = false;     // close() ends the client for good: no call connects it again
  const forget = (which) => {
    if (connected !== which || which == null) return;
    connected = null;
    which.then((client) => client.close(), () => {}).catch(() => {});
  };
  const connect = (ms) => {
    if (closed) return Promise.reject(Object.assign(new Error('the client is closed'), {remoteCode: 'REMOTE_UNREACHABLE'}));
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
    // (text the remote sent, with the credential and its long parts
    // replaced: for what the runtime logs of it, as the load line's tool
    // names; the value itself never leaves this closure)
    scrub,
    // Every tool, following nextCursor: [{name, inputSchema}].
    // A cursor seen before, more than MAX_PAGES pages, more than MAX_TOOLS
    // tools or MAX_LISTING_CHARS characters, or a tool not shaped {name:
    // string, inputSchema: object}, is REMOTE_PROTOCOL. Sent as `call` sends
    // tools/call: the SDK compiles no schema of the remote's.
    list: () => run(async (client, left) => {
      const tools = [];
      const seen = new Set();
      let chars = 0;
      let cursor;
      do {
        if (seen.size >= MAX_PAGES) throw new Error(`tools/list went past ${MAX_PAGES} pages`);
        const page = await client.request({method: 'tools/list', params: cursor != null ? {cursor: cursor} : {}}, ResultSchema, {timeout: left()});
        if (!Array.isArray(page.tools)) throw new Error('tools/list answered without a list of tools');
        if (tools.length + page.tools.length > MAX_TOOLS) throw new Error(`tools/list listed more than ${MAX_TOOLS} tools`);
        for (let i = 0; i < page.tools.length; i++) {
          const t = page.tools[i];
          if (!isPlainObject(t) || typeof t.name !== 'string' || !isPlainObject(t.inputSchema)) throw new Error(`tools/list's tool ${tools.length} is not {name, inputSchema}`);
          chars += JSON.stringify(t.name).length + JSON.stringify(t.inputSchema).length;
          if (chars > MAX_LISTING_CHARS) throw new Error(`tools/list listed more than ${MAX_LISTING_CHARS} characters of tools`);
          tools.push({name: t.name, inputSchema: t.inputSchema});
        }
        cursor = page.nextCursor;
        if (cursor != null && typeof cursor !== 'string') throw new Error('tools/list answered a cursor that is not a string');
        if (cursor != null && seen.has(cursor)) throw new Error(`tools/list repeated the cursor ${JSON.stringify(cursor).slice(0, 64)}`);
        if (cursor != null) seen.add(cursor);
      } while (cursor != null);
      return tools;
    }),
    // The CallToolResult as the server sent it. signal: an AbortSignal that
    // cuts the request off (M19: the call it was made for was cancelled)
    call: (tool, args, {signal} = {}) => run((client, left) => client.request({method: 'tools/call', params: {name: tool, arguments: args}},
      CallToolResultSchema, signal != null ? {timeout: left(), signal} : {timeout: left()})),
    close: async () => {
      closed = true;
      const c = connected;
      connected = null;
      if (c != null) await c.then((client) => client.close(), () => {});
      agent.destroy();
    }
  };
}

module.exports = {createRemoteClient, codeFor, configuredRedis, MAX_TOOLS, MAX_LISTING_CHARS};
