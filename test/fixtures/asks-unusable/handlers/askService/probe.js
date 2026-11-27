// Waits until its data holds a "go" file (bounded: 20 s), noting "started"
// first, then asks a question no form can show (a hidden character in its
// enum): the pass ends on its question, the question is unavailable, and
// the run starts again at once, where ctx.ask is ASK_UNAVAILABLE. Each pass
// is counted in its data ("passes", one line each).
const fs = require('fs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (input, ctx) => {
  fs.appendFileSync('/data/passes', 'pass\n');
  fs.writeFileSync('/data/started', '1');
  const end = Date.now() + 20000;
  while (!fs.existsSync('/data/go') && Date.now() < end) await wait(50);
  try {
    await ctx.ask('pick', {});
    return {output: {asked: true}};
  } catch (e) {
    if (e.code === 'ASK_UNAVAILABLE') return {output: {asked: false, code: e.code}};
    throw e;
  }
};
