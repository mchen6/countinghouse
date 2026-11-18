'use strict';
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

// An IPv6 address as its eight 16-bit groups (WHATWG compresses it first).
const groupsOf = (v6) => {
  const [head, tail] = v6.includes('::') ? v6.split('::') : [v6, null];
  const h = (head !== '') ? head.split(':') : [];
  const t = (tail != null && tail !== '') ? tail.split(':') : [];
  const fill = (tail != null) ? new Array(8 - h.length - t.length).fill('0') : [];
  return h.concat(fill, t).map((g) => parseInt(g, 16));
};
const dotted = (high, low) => [high >> 8, high & 255, low >> 8, low & 255].join('.');

// The IPv4 address an IPv6 one carries, or null: IPv4-mapped
// (::ffff:a.b.c.d), SIIT (::ffff:0:a.b.c.d), IPv4-compatible (::a.b.c.d),
// NAT64 (64:ff9b::/96 and the local-use 64:ff9b:1::/48) and 6to4 (2002::/16).
function embeddedV4(v6) {
  if (v6 === '::' || v6 === '::1') return null;
  const g = groupsOf(v6);
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return dotted(g[6], g[7]);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return dotted(g[6], g[7]);
  if (zero(0, 6)) return dotted(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b) return dotted(g[6], g[7]);
  if (g[0] === 0x2002) return dotted(g[1], g[2]);
  return null;
}

// A host in one spelling: lower-cased, unbracketed, without a trailing dot;
// an IPv6 address compressed as WHATWG writes it, and one that carries an
// IPv4 address (embeddedV4), in hex or dotted form, read as that IPv4
// address. Used on a URL's hostname and on an address a name resolved to.
const plainHost = (hostname) => {
  let h = String(hostname).toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (net.isIPv6(h)) {
    h = new URL(`http://[${h}]/`).hostname.slice(1, -1);
    const v4 = embeddedV4(h);
    return (v4 != null) ? v4 : h;
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
// IPv6: unique local fc00::/7, link-local fe80::/10, the old site-local
// fec0::/10, multicast ff00::/8 (host compressed, so the first group is
// written without leading zeros).
const nonPublicV6 = (host) => /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89a-f][0-9a-f]:/.test(host) || /^ff[0-9a-f]{2}:/.test(host);

const isNonPublic = (host) => (net.isIPv4(host) ? nonPublicV4(host) : (net.isIPv6(host) ? nonPublicV6(host) : false));

// Why an address (a literal host, or one a name resolved to) may not be a
// remote's, or null. The Redis endpoint is refused always: its host, the
// addresses that host resolves to (opts.redisAddresses, from the lookup),
// and loopback on its port, since a Redis bound to every interface answers
// there too. Loopback and non-public addresses are refused outside --debug
// (spec, Security). port: a number.
function refusedAddress(host, port, opts) {
  const o = opts || {};
  const h = plainHost(host);
  const redis = o.redisEndpoint;
  if (redis != null && Number(redis.port) === Number(port)) {
    const known = [redis.host].concat(o.redisAddresses || []).map(plainHost);
    if (known.includes(h) || isLoopbackHost(h)) return 'it is the Redis endpoint';
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

// M3 (#413 section 6.1): "credential": "VAR" is the short form of
// {"env": "VAR"}, with the header and scheme defaulting as the object's do.
function parseCredential(value, at, problems) {
  if (value == null) return null;
  if (typeof(value) === 'string') {
    if (!VARIABLE.test(value)) return problems.push(`${at}.credential must name an environment variable`), null;
    return {env: value, fallbackEnv: null, header: 'Authorization', scheme: 'Bearer'};
  }
  if (typeof(value) !== 'object' || Array.isArray(value)) return problems.push(`${at}.credential must be a variable name or an object`), null;
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

// The remote as the load keeps it, in plain JSON (M3, #413 section 6.1):
// what countinghouse-validate prints, whichever form the author wrote.
function expanded(name, u, headers, credential) {
  const out = {name: name, transport: 'streamable-http', url: u.href};
  if (Object.keys(headers).length > 0) out.headers = Object.assign({}, headers);
  if (credential != null) {
    out.credential = {env: credential.env};
    if (credential.fallbackEnv != null) out.credential.fallbackEnv = credential.fallbackEnv;
    out.credential.header = credential.header;
    out.credential.scheme = credential.scheme;
  }
  return out;
}

// pkg: the module's package.json. opts: {debug, redisEndpoint: {host, port},
// maxRemotes (1 in RC1-min)}. -> {remotes: [{name, url: URL, origin,
// headers, credential: {env, fallbackEnv, header, scheme} | null, declared}],
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
    // M3: "streamable-http" is the default, and still the only transport
    if (d.transport !== undefined && d.transport !== 'streamable-http') return problems.push(`${at}.transport must be "streamable-http"`), null;
    const u = parseUrl(d.url, at, o, problems);
    const credential = parseCredential(d.credential, at, problems);
    if (d.credential != null && credential == null) return null;
    const headers = parseHeaders(d.headers, at, (credential != null) ? credential.header : 'Authorization', problems);
    if (u == null || headers == null) return null;
    return {name: d.name, url: u, origin: u.origin, headers: headers, credential: credential,
      declared: expanded(d.name, u, headers, credential)};
  });
  return problems.length > 0 ? {remotes: [], problems: problems} : {remotes: remotes, problems: []};
}

// What a parsed remote does with its credential, in one line (M3,
// countinghouse-validate): where it goes and in which header.
function meaningOf(remote) {
  const c = remote.credential;
  if (c == null) return `sends no credential to ${remote.origin}`;
  const value = (c.scheme === '') ? '<value>' : `${c.scheme} <value>`;
  const fallback = (c.fallbackEnv != null) ? ` (its fallbackEnv ${c.fallbackEnv} is read only under a version 1 --remoteCredentials file)` : '';
  return `sends the credential ${c.env} to ${remote.origin} as "${c.header}: ${value}"${fallback}`;
}

// A refused declaration's fix line (M3, #413 section 6.1): the shortest
// form when it means what the author wrote (no headers, the Authorization
// header and the Bearer scheme, no fallbackEnv), else the full form; filled
// in with the name and the credential's variable where they read, and the
// URL only where it passes the URL checks, its query left out (#422's high
// review, 3: a refused URL is never offered back, so the fix fixes). Header
// values are never shown; a field the grammar refuses is a placeholder,
// never dropped. -> the line's text.
function fixFormOf(pkg) {
  const declared = (pkg != null && pkg.countinghouse != null) ? pkg.countinghouse.remotes : undefined;
  const d = (Array.isArray(declared) && declared[0] != null && typeof(declared[0]) === 'object' && !Array.isArray(declared[0])) ? declared[0] : {};
  const u = (typeof(d.url) === 'string' && d.url.length <= 2048) ? parseUrl(d.url, 'url', {debug: false, redisEndpoint: null}, []) : null;
  // parseUrl has refused user info and a fragment already; a query can
  // carry a secret too, so it is never printed back
  let url = '<https URL of your server>';
  if (u != null) url = `${u.origin}${u.pathname}${u.search !== '' ? '?<query>' : ''}`;
  const name = (typeof(d.name) === 'string' && NAME.test(d.name)) ? d.name : '<name>';
  const c = d.credential;
  const obj = (c != null && typeof(c) === 'object' && !Array.isArray(c)) ? c : null;
  const variable = (typeof(c) === 'string') ? c : (obj != null ? obj.env : null);
  const env = (typeof(variable) === 'string' && VARIABLE.test(variable)) ? variable : '<VARIABLE>';
  const headers = (d.headers != null && typeof(d.headers) === 'object' && !Array.isArray(d.headers)) ? Object.keys(d.headers) : [];
  const custom = obj != null && ((obj.header != null && obj.header !== 'Authorization') || (obj.scheme != null && obj.scheme !== 'Bearer') || obj.fallbackEnv != null);
  const tail = '; see "Declaring a remote MCP server" in docs/module-development.md';
  if (headers.length === 0 && !custom) {
    const short = {name: name, url: url};
    if (c != null) short.credential = env;
    return `the shortest form is ${JSON.stringify(short)}${tail}`;
  }
  const full = {name: name, transport: 'streamable-http', url: url};
  const named = headers.filter((h) => TOKEN.test(h)).slice(0, 16);
  if (named.length > 0) full.headers = Object.fromEntries(named.map((h) => [h, '<value>']));
  if (c != null) {
    full.credential = {env: env};
    const as = (v, ok, placeholder) => (ok(v) ? v : placeholder);
    if (obj != null && obj.fallbackEnv != null) full.credential.fallbackEnv = as(obj.fallbackEnv, (v) => typeof(v) === 'string' && VARIABLE.test(v), '<VARIABLE>');
    if (obj != null && obj.header != null) full.credential.header = as(obj.header, (v) => typeof(v) === 'string' && TOKEN.test(v), '<header>');
    if (obj != null && obj.scheme != null) full.credential.scheme = as(obj.scheme, (v) => typeof(v) === 'string' && (v === '' || TOKEN.test(v)), '<scheme>');
  }
  return `the full form is ${JSON.stringify(full)}${tail}`;
}

module.exports = {parseRemotes, refusedAddress, plainHost, portOf, VARIABLE, NAME, meaningOf, fixFormOf};
