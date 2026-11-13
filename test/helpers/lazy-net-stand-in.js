// A loopback stand-in for the lazy-net-probe fixture (test/sandbox/40 and 09):
// "ok" at every path. On an ephemeral port, so no fixed port is taken.
const http = require('http');

// -> Promise of {server, port, base, close()}.
async function startStandIn() {
  const server = http.createServer((req, res) => {
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {server, port, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r))};
}

module.exports = {startStandIn};
