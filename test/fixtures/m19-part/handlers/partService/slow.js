// m19-part fixture (M19): see test/mcp-contract/19-cancel-e2e.js
const fs = require('fs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// one line per run, in this module's own /data, so a test can count runs
const ran = (what) => fs.appendFileSync('/data/runs', `${what}\n`);
module.exports = async () => {
  await wait(300);
  ran('slow');
  return {output: {done: true}};
};
