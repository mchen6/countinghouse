// m19-part fixture (M19): see test/mcp-contract/19-cancel-e2e.js
const fs = require('fs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// one line per run, in this module's own /data, so a test can count runs; its
// start too, so a test can act on what it sees, never on timing (#335)
const ran = (what) => fs.appendFileSync('/data/runs', `${what}\n`);
// held while /data/hold says `leaf` (a test removes it to let the leaf end)
const held = () => { try { return fs.readFileSync('/data/hold', 'utf8') === 'leaf'; } catch (e) { return false; } };
module.exports = async () => {
  ran('start-leaf');
  await wait(800);
  for (let w = 0; held() && w < 30000; w += 20) await wait(20);
  ran('leaf');
  return {output: {done: true}};
};
