// tlsRoundTrip.js -- tls.connect to 127.0.0.1:port and one HTTP/1.0 GET over
// the secure socket: {code: 'round-trip', authorized, body}, or the error code.
module.exports = (input) => new Promise((resolve) => {
  let s = null;
  let body = '';
  const timer = setTimeout(() => { if (s != null) s.destroy(); finish({code: 'timeout'}); }, 5000);
  const finish = (out) => { clearTimeout(timer); resolve({output: out}); };
  try {
    s = require('tls').connect({port: input.port, host: '127.0.0.1'}, () => {
      s.write('GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n');
    });
  } catch (e) {
    return finish({code: String(e.code || e.message)});
  }
  s.on('data', (d) => { body += d.toString(); });
  s.once('end', () => finish({code: 'round-trip', authorized: s.authorized, body: body.split('\r\n\r\n')[1] || ''}));
  s.once('error', (e) => finish({code: String(e.code || e.message)}));
});
