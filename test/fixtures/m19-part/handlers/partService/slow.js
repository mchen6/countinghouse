// m19-part fixture (M19): see test/mcp-contract/19-cancel-e2e.js
const fs = require('fs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// one line per run, in this module's own /data, so a test can count runs; a
// run's start too, so a test can act on what it sees, never on timing (#335)
const ran = (what) => fs.appendFileSync('/data/runs', `${what}\n`);
// a test holds the run it names in /data/hold (this hop's number, 1 to 5)
// until it removes the file: a cancel lands while the run is known to run
const held = (at) => { try { return fs.readFileSync('/data/hold', 'utf8') === String(at); } catch (e) { return false; } };
module.exports = async () => {
  ran('start');
  const n = fs.readFileSync('/data/runs', 'utf8').split('\n').filter((l) => l === 'start').length;
  await wait(300);
  for (let w = 0; held(n) && w < 30000; w += 20) await wait(20);
  ran('slow');
  return {output: {done: true}};
};
