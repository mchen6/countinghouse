// tlsConnect.js -- tls.connect: 'connected', or the error code.
module.exports = (input) => new Promise((resolve) => {
  let s = null;
  try {
    s = require('tls').connect({port: input.port, host: input.host, rejectUnauthorized: false});
  } catch (e) {
    return resolve({output: {code: String(e.code || e.message)}});
  }
  s.once('secureConnect', () => { s.destroy(); resolve({output: {code: 'connected'}}); });
  s.once('error', (e) => resolve({output: {code: String(e.code || e.message)}}));
  setTimeout(() => { s.destroy(); resolve({output: {code: 'timeout'}}); }, 3000);
});
