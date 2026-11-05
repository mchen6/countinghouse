// The address the server binds: --bindAddr, else loopback. It used to be the
// first non-internal IPv4 address, which put an unauthenticated --debug
// server on the network (review R1-2; user decision, 2026-11-04). Its own
// module so framework.js can check it before anything else loads.
const options = require('./cli-options');

function hostIp() {
  return options.bindAddr != null ? options.bindAddr : '127.0.0.1';
}

function isLoopback(addr) {
  return addr === 'localhost' || addr === '::1' || /^127\./.test(String(addr));
}

module.exports = {hostIp, isLoopback};
