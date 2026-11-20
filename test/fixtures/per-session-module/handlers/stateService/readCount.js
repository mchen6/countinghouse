// per-session-module fixture: its /data counter, read as a resource (M7)
const fs = require('fs');
module.exports = async () => {
  let n = '0';
  try { n = fs.readFileSync('/data/count', 'utf8'); } catch (e) { n = '0'; }
  return {output: n};
};
