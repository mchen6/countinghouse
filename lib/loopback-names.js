// Loopback, as the worker lockdown's Redis denial and the remote client's
// URL check both read it (L1, RC1-min), so the two never disagree. The
// names /etc/hosts gives to loopback by default: Debian's, and RHEL and
// Fedora's (L1 round 5). Spelling only: a name that reaches loopback
// through another hosts entry or DNS is not caught here.
const net = require('net');

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'localhost4', 'localhost4.localdomain4', 'localhost6', 'localhost6.localdomain6']);

// name: lower-cased, without a trailing dot.
const isLoopbackName = (name) => LOOPBACK_NAMES.has(name) || name.endsWith('.localhost');

// host: a canonical address or a lower-cased name (an IPv4-mapped or
// -compatible address already read as its IPv4 one). 127/8 and 0.0.0.0,
// ::1 and ::, and the names.
function isLoopbackHost(host) {
  if (net.isIPv4(host)) return host === '0.0.0.0' || host.startsWith('127.');
  if (net.isIPv6(host)) return host === '::1' || host === '::';
  return isLoopbackName(host);
}

module.exports = {LOOPBACK_NAMES, isLoopbackName, isLoopbackHost};
