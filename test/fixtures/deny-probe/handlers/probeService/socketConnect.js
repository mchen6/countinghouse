// socketConnect.js -- new net.Socket().connect: 'connected', or the error code.
module.exports = (input) => new Promise((resolve) => {
  let s = null;
  try {
    s = new (require('net').Socket)().connect(input.port, input.host);
  } catch (e) {
    return resolve({output: {code: String(e.code || e.message)}});
  }
  s.once('connect', () => { s.destroy(); resolve({output: {code: 'connected'}}); });
  s.once('error', (e) => resolve({output: {code: String(e.code || e.message)}}));
  setTimeout(() => { s.destroy(); resolve({output: {code: 'timeout'}}); }, 3000);
});
