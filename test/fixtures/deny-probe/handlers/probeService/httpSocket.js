// httpSocket.js -- http.request over a unix socket: 'connected', or the error code.
module.exports = (input) => new Promise((resolve) => {
  let req = null;
  try {
    req = require('http').request({socketPath: input.socketPath, path: '/', method: 'GET'});
  } catch (e) {
    return resolve({output: {code: String(e.code || e.message)}});
  }
  req.once('response', (res) => { res.resume(); resolve({output: {code: 'connected'}}); });
  req.once('error', (e) => resolve({output: {code: String(e.code || e.message)}}));
  setTimeout(() => { req.destroy(); resolve({output: {code: 'timeout'}}); }, 3000);
  req.end();
});
