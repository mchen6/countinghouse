// RC1-min: the fetch the SDK's StreamableHTTPClientTransport uses for a
// remote MCP server, over node:http and node:https rather than the global
// fetch, for three things the spec asks of the main thread's connection:
//
// - no redirect is followed: http.request returns a 3xx as it is, so a
//   credential never goes to a second location (spec section 4);
// - an answer is cut off at maxBytes as it streams, so a server cannot fill
//   the main thread's memory (REMOTE_RESULT_TOO_LARGE);
// - the connection's address lookup is ours to wrap (Task 2b), the hook
//   undici's connect.lookup would be, with no new dependency.
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const {refusedAddress, portOf} = require('./declaration');
const {Readable, Transform} = require('stream');

// The marker on the JSON-RPC error that ends a capped event stream (the SDK
// does not surface an error thrown inside an event stream: the call would
// wait for its timeout), read by client.js.
const TOO_LARGE = 'countinghouse/REMOTE_RESULT_TOO_LARGE';

const tooLarge = () => Object.assign(new Error(`the remote's answer is over the limit`), {remoteCode: 'REMOTE_RESULT_TOO_LARGE'});

// The JSON-RPC request id a POST carries, so a capped event stream can end
// with an error for that request.
function requestIdOf(body) {
  if (typeof(body) !== 'string') return null;
  try {
    const m = JSON.parse(body);
    return (m != null && typeof(m) === 'object' && !Array.isArray(m) && m.id != null) ? m.id : null;
  } catch (e) {
    return null;
  }
}

function capped(res, maxBytes, sse, requestId) {
  let seen = 0;
  let ended = false;
  const cap = new Transform({
    transform(chunk, enc, cb) {
      if (ended) return cb();
      seen += chunk.length;
      if (seen <= maxBytes) return cb(null, chunk);
      ended = true;
      res.destroy();
      if (!sse || requestId == null) return cb(tooLarge());
      const error = {jsonrpc: '2.0', id: requestId, error: {code: -32603, message: 'REMOTE_RESULT_TOO_LARGE', data: {marker: TOO_LARGE}}};
      this.push(`\n\nevent: message\ndata: ${JSON.stringify(error)}\n\n`);
      this.push(null);
      return cb();
    }
  });
  res.on('error', (e) => { if (!ended) cap.destroy(e); });
  return res.pipe(cap);
}

// Step 2b: the connection's lookup, refusing a name whose answer is a
// loopback, private or Redis-endpoint address before the socket opens
// (declaration.js's refusedAddress, the literal check's own rule, on each
// address the name resolves to). A Redis endpoint configured by name is
// resolved too, so it is compared address to address. resolve: dns.lookup's
// signature. opts: {debug, port, redisEndpoint}. An IP literal never
// reaches a lookup; the load's literal check has already refused it.
function guardedLookup(resolve, opts) {
  const all = (name, cb) => resolve(name, {all: true}, (err, list) => cb(err, Array.isArray(list) ? list : []));
  const redisHost = (opts.redisEndpoint != null) ? String(opts.redisEndpoint.host) : null;
  return (hostname, options, cb) => {
    resolve(hostname, Object.assign({}, options, {all: true}), (err, answer) => {
      if (err != null) return cb(err);
      const addresses = Array.isArray(answer) ? answer : [];
      if (addresses.length === 0) {
        return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {code: 'ENOTFOUND', hostname: hostname}));
      }
      const check = (redisAddresses) => {
        const o = Object.assign({}, opts, {redisAddresses: redisAddresses});
        for (const a of addresses) {
          const why = refusedAddress(a.address, opts.port, o);
          if (why != null) {
            return cb(Object.assign(new Error(`${hostname} resolves to ${a.address}, which is refused: ${why}`),
              {remoteCode: 'REMOTE_ADDRESS_REFUSED'}));
          }
        }
        if (options != null && options.all) return cb(null, addresses);
        return cb(null, addresses[0].address, addresses[0].family);
      };
      if (redisHost == null || net.isIP(redisHost.replace(/^\[|\]$/g, '')) !== 0) return check([]);
      // An unresolvable Redis name is no address to compare against.
      return all(redisHost, (e, list) => check(list.map((x) => x.address)));
    });
  };
}

function headersOf(init) {
  const out = {};
  new Headers(init != null ? init.headers : undefined).forEach((v, k) => { out[k] = v; });
  return out;
}

const remoteError = (code, message) => Object.assign(new Error(message), {remoteCode: code});

// opts: {maxBytes, timeoutMs, agent?, debug, redisEndpoint, resolve?}. -> a
// FetchLike: (url, init) -> Promise<Response>. Each request is ended at
// timeoutMs, its answer included, so a call the SDK gave up on leaves no
// socket open. agent: the client's own, which close() destroys, so no idle
// socket outlives it. resolve: dns.lookup's signature (tests inject one).
function makeFetch(opts) {
  const o = opts || {};
  // One lookup per port (in practice the remote's one URL), built once.
  const lookups = new Map();
  const lookupFor = (port) => {
    if (!lookups.has(port)) lookups.set(port, guardedLookup(o.resolve || dns.lookup, {debug: o.debug === true, port: port, redisEndpoint: o.redisEndpoint}));
    return lookups.get(port);
  };
  return (url, init) => new Promise((resolve, reject) => {
    const u = (url instanceof URL) ? url : new URL(String(url));
    const signal = (init != null) ? init.signal : null;
    if (signal != null && signal.aborted) return reject(signal.reason);
    const mod = (u.protocol === 'https:') ? https : http;
    const requestOptions = {method: (init != null && init.method) || 'GET', headers: headersOf(init)};
    requestOptions.lookup = lookupFor(portOf(u));
    if (o.agent != null) requestOptions.agent = o.agent;
    const body = (init != null) ? init.body : null;
    let timer = null;
    let onAbort = null;
    // The SDK's signal is one per transport, shared by every request, so
    // each request's listener goes when the request does.
    const done = () => {
      if (timer != null) clearTimeout(timer);
      if (onAbort != null && signal != null) signal.removeEventListener('abort', onAbort);
      timer = null;
      onAbort = null;
    };
    const req = mod.request(u, requestOptions, (res) => {
      res.on('close', done);
      // Outside the executor's own try: a status a Response cannot carry
      // (Node's parser takes any three digits) would otherwise throw out of
      // this listener and end the process.
      try {
        if (res.statusCode < 200 || res.statusCode > 599) {
          res.destroy();
          return reject(remoteError('REMOTE_PROTOCOL', `the remote answered HTTP status ${res.statusCode}`));
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
          else if (v != null) headers.set(k, v);
        }
        const empty = [204, 205, 304].includes(res.statusCode) || (requestOptions.method === 'HEAD');
        const sse = String(res.headers['content-type'] || '').startsWith('text/event-stream');
        const stream = empty ? null : Readable.toWeb(capped(res, o.maxBytes, sse, requestIdOf(body)));
        return resolve(new Response(stream, {status: res.statusCode, headers: headers}));
      } catch (e) {
        res.destroy();
        return reject(remoteError('REMOTE_PROTOCOL', `the remote's answer could not be read: ${e.message}`));
      }
    });
    req.on('error', (e) => { done(); reject(e); });
    req.on('close', () => { if (req.res == null) done(); });
    if (o.timeoutMs != null) {
      timer = setTimeout(() => req.destroy(remoteError('REMOTE_TIMEOUT', `no answer within ${o.timeoutMs} ms`)), o.timeoutMs);
    }
    if (signal != null) {
      onAbort = () => req.destroy(signal.reason);
      signal.addEventListener('abort', onAbort, {once: true});
    }
    if (body != null) req.end(body); else req.end();
  });
}

module.exports = {makeFetch, guardedLookup, TOO_LARGE};
