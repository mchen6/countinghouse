// RC1-min: package.json's countinghouse.remotes, the one remote MCP server
// a module declares (docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-
// design.md, section 1). Parsed on the main thread at load; a problem names
// the declaration's position and field, and refuses the load.
const net = require('net');
const {isLoopbackHost} = require('../loopback-names');

const FIELDS            = new Set(['name', 'transport', 'url', 'headers', 'credential']);
const CREDENTIAL_FIELDS = new Set(['env', 'fallbackEnv', 'header', 'scheme']);
const NAME     = /^[a-z][a-z0-9-]{0,31}$/;
const TOKEN    = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;   // an RFC 9110 field name
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Hop-by-hop (RFC 9110 7.6.1), and the headers the transport sets itself.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade']);
const TRANSPORT_OWN = new Set(['host', 'content-length', 'content-type', 'accept', 'mcp-session-id',
  'mcp-protocol-version', 'cookie']);

// A host in one spelling: lower-cased, unbracketed, without a trailing dot;
// an IPv6 address compressed as WHATWG writes it, and an IPv4-mapped
// (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) or NAT64 (64:ff9b::a.b.c.d)
// one, in hex or dotted form, read as its IPv4 address. Used on a URL's
// hostname and on an address a name resolved to.
const plainHost = (hostname) => {
  let h = String(hostname).toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (net.isIPv6(h)) {
    h = new URL(`http://[${h}]/`).hostname.slice(1, -1);
    const v4 = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (v4 == null) return h;
    const high = parseInt(v4[1], 16), low = parseInt(v4[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return h.endsWith('.') ? h.slice(0, -1) : h;
};

// IPv4 ranges that are not the public internet, beyond loopback: 0/8,
// 10/8, CGNAT 100.64/10 (cloud metadata lives there too), link-local
// 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, benchmarking 198.18/15,
// multicast and reserved 224/3 (255.255.255.255 included).
const nonPublicV4 = (host) => {
  const [a, b, c] = host.split('.').map(Number);
  return a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
};
// IPv6: unique local fc00::/7, link-local fe80::/10, multicast ff00::/8
// (host compressed, so the first group is written without leading zeros).
const nonPublicV6 = (host) => /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || /^ff[0-9a-f]{2}:/.test(host);

const isNonPublic = (host) => (net.isIPv4(host) ? nonPublicV4(host) : (net.isIPv6(host) ? nonPublicV6(host) : false));

// Why an address (a literal host, or one a name resolved to) may not be a
// remote's, or null. The Redis endpoint is refused always; loopback and
// private addresses outside --debug (spec, Security). host as plainHost
// gives it; port a number.
function refusedAddress(host, port, opts) {
  const o = opts || {};
  const h = plainHost(host);
  const redis = o.redisEndpoint;
  if (redis != null && Number(redis.port) === Number(port)) {
    const rh = plainHost(redis.host);
    if (h === rh || (isLoopbackHost(h) && isLoopbackHost(rh))) return 'it is the Redis endpoint';
  }
  if (o.debug === true) return null;
  if (isLoopbackHost(h)) return 'it is a loopback address';
  if (isNonPublic(h)) return 'it is a private or non-public address';
  return null;
}

const portOf = (u) => (u.port !== '' ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80));

function parseUrl(value, at, opts, problems) {
  if (typeof(value) !== 'string') return problems.push(`${at}.url must be a string`), null;
  let u = null;
  try { u = new URL(value); } catch (e) { return problems.push(`${at}.url is not an absolute URL`), null; }
  if (u.username !== '' || u.password !== '') return problems.push(`${at}.url carries user info`), null;
  if (u.hash !== '' || value.includes('#')) return problems.push(`${at}.url carries a fragment`), null;
  const host = plainHost(u.hostname);
  const httpAllowed = opts.debug === true && isLoopbackHost(host);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && httpAllowed)) {
    return problems.push(`${at}.url must be https (http only to a loopback host under --debug)`), null;
  }
  const refused = refusedAddress(host, portOf(u), opts);
  if (refused != null) return problems.push(`${at}.url is refused: ${refused}`), null;
  return u;
}

function parseCredential(value, at, problems) {
  if (value == null) return null;
  if (typeof(value) !== 'object' || Array.isArray(value)) return problems.push(`${at}.credential must be an object`), null;
  if (Object.prototype.hasOwnProperty.call(value, 'grant')) {
    return problems.push(`${at}.credential.grant: a refresh-token grant is not supported yet`), null;
  }
  const unknown = Object.keys(value).filter((k) => !CREDENTIAL_FIELDS.has(k));
  if (unknown.length > 0) return problems.push(`${at}.credential.${unknown[0]} is not a credential field`), null;
  if (typeof(value.env) !== 'string' || !VARIABLE.test(value.env)) {
    return problems.push(`${at}.credential.env must name an environment variable`), null;
  }
  if (value.fallbackEnv != null && (typeof(value.fallbackEnv) !== 'string' || !VARIABLE.test(value.fallbackEnv))) {
    return problems.push(`${at}.credential.fallbackEnv must name an environment variable`), null;
  }
  const header = (value.header != null) ? value.header : 'Authorization';
  if (typeof(header) !== 'string' || !TOKEN.test(header)) return problems.push(`${at}.credential.header is not a header name`), null;
  const scheme = (value.scheme != null) ? value.scheme : 'Bearer';
  if (typeof(scheme) !== 'string' || (scheme !== '' && !TOKEN.test(scheme))) {
    return problems.push(`${at}.credential.scheme is not an auth scheme`), null;
  }
  return {env: value.env, fallbackEnv: (value.fallbackEnv != null) ? value.fallbackEnv : null, header: header, scheme: scheme};
}

function parseHeaders(value, at, credentialHeader, problems) {
  if (value == null) return {};
  if (typeof(value) !== 'object' || Array.isArray(value)) return problems.push(`${at}.headers must be an object`), null;
  const seen = new Set();
  const out = {};
  for (const [name, v] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (!TOKEN.test(name)) return problems.push(`${at}.headers: ${JSON.stringify(name)} is not a header name`), null;
    // Node's http refuses any other character at request time; refused here
    // at load instead.
    if (typeof(v) !== 'string' || /[^\t\x20-\x7e\x80-\xff]/.test(v)) {
      return problems.push(`${at}.headers.${name}: the value must be a string of visible Latin-1 characters, spaces and tabs`), null;
    }
    if (seen.has(lower)) return problems.push(`${at}.headers.${name} is given twice (names are compared case-insensitively)`), null;
    if (lower === credentialHeader.toLowerCase()) {
      return problems.push(`${at}.headers.${name} is the credential's header: a secret goes only through the credential block`), null;
    }
    if (HOP_BY_HOP.has(lower)) return problems.push(`${at}.headers.${name} is a hop-by-hop header`), null;
    if (TRANSPORT_OWN.has(lower)) return problems.push(`${at}.headers.${name} is set by the transport itself`), null;
    seen.add(lower);
    out[name] = v;
  }
  return out;
}

// pkg: the module's package.json. opts: {debug, redisEndpoint: {host, port},
// maxRemotes (1 in RC1-min)}. -> {remotes: [{name, url: URL, origin,
// headers, credential: {env, fallbackEnv, header, scheme} | null}],
// problems: [string]}; any problem means no remotes.
function parseRemotes(pkg, opts) {
  const o = Object.assign({debug: false, redisEndpoint: null, maxRemotes: 1}, opts);
  const declared = (pkg != null && pkg.countinghouse != null) ? pkg.countinghouse.remotes : undefined;
  if (declared === undefined) return {remotes: [], problems: []};
  if (!Array.isArray(declared)) return {remotes: [], problems: ['countinghouse.remotes must be an array']};
  const problems = [];
  if (declared.length > o.maxRemotes) {
    problems.push(`countinghouse.remotes[${o.maxRemotes}]: at most ${o.maxRemotes} remote per module in this version`);
  }
  const names = new Set();
  const remotes = declared.slice(0, o.maxRemotes).map((d, i) => {
    const at = `countinghouse.remotes[${i}]`;
    if (d == null || typeof(d) !== 'object' || Array.isArray(d)) return problems.push(`${at} must be an object`), null;
    const unknown = Object.keys(d).filter((k) => !FIELDS.has(k));
    if (unknown.length > 0) return problems.push(`${at}.${unknown[0]} is not a remote field`), null;
    if (typeof(d.name) !== 'string' || !NAME.test(d.name)) return problems.push(`${at}.name must match ${NAME}`), null;
    if (names.has(d.name)) return problems.push(`${at}.name ${JSON.stringify(d.name)} is declared twice`), null;
    names.add(d.name);
    if (d.transport !== 'streamable-http') return problems.push(`${at}.transport must be "streamable-http"`), null;
    const u = parseUrl(d.url, at, o, problems);
    const credential = parseCredential(d.credential, at, problems);
    if (d.credential != null && credential == null) return null;
    const headers = parseHeaders(d.headers, at, (credential != null) ? credential.header : 'Authorization', problems);
    if (u == null || headers == null) return null;
    return {name: d.name, url: u, origin: u.origin, headers: headers, credential: credential};
  });
  return problems.length > 0 ? {remotes: [], problems: problems} : {remotes: remotes, problems: []};
}

module.exports = {parseRemotes, refusedAddress, plainHost, VARIABLE};
