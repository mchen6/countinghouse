// Waits until its data holds a "go" file, noting "started" first (bounded:
// 60 s, then it fails, saying so), then asks a question no form can show (a
// hidden character in its enum): the pass ends on its question, the
// question is unavailable, and the run starts again at once, where ctx.ask
// is ASK_UNAVAILABLE. Each pass is counted in its data ("passes", one line
// each), and what each ask threw ("ask-codes", one code a line).
const fs = require('fs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (input, ctx) => {
  fs.appendFileSync('/data/passes', 'pass\n');
  fs.writeFileSync('/data/started', '1');
  const end = Date.now() + 60000;
  while (!fs.existsSync('/data/go')) {
    if (Date.now() > end) throw new Error('no go file within 60 s');
    await wait(50);
  }
  try {
    await ctx.ask('pick', {});
    return {output: {asked: true}};
  } catch (e) {
    fs.appendFileSync('/data/ask-codes', `${e.code}\n`);
    if (e.code === 'ASK_UNAVAILABLE') return {output: {asked: false, code: e.code}};
    throw e;
  }
};
