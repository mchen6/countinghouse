// httpsGet.js -- https.get from 127.0.0.1:port: {code: 'status', status, body},
// or the error code.
module.exports = (input) => new Promise((resolve) => {
  let req = null;
  const timer = setTimeout(() => { if (req != null) req.destroy(); finish({code: 'timeout'}); }, 5000);
  const finish = (out) => { clearTimeout(timer); resolve({output: out}); };
  try {
    req = require('https').get({port: input.port, host: '127.0.0.1', path: '/'}, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.once('end', () => finish({code: 'status', status: res.statusCode, body: body}));
    });
  } catch (e) {
    return finish({code: String(e.code || e.message)});
  }
  req.once('error', (e) => finish({code: String(e.code || e.message)}));
});
