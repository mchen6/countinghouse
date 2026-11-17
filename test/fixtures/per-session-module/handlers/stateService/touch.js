// per-session-module fixture (shared runtime R1): see
// test/module-loading/36-per-session-declaration.js. A counter in its own
// /data, so a test can tell whose files a call reached.
const fs = require('fs');
module.exports = async () => {
  let n = 0;
  try { n = Number(fs.readFileSync('/data/count', 'utf8')) || 0; } catch (e) { n = 0; }
  n += 1;
  fs.writeFileSync('/data/count', String(n));
  return {output: {file: n}};
};
