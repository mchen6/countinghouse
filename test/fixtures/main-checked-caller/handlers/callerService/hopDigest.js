// hopDigest.js -- main-checked's big over a hop, reported as its length and
// sha256, so a large result is never echoed to the client; input.wait is
// passed on (test/sandbox/42).
const crypto = require('crypto');
module.exports = async (input, ctx) => {
  try {
    const args = Number.isInteger(input.wait) ? {n: input.n, wait: input.wait} : {n: input.n};
    const result = await ctx.call('main-checked/checkService.big', args);
    const text = JSON.stringify(result);
    return {output: {length: text.length, sha256: crypto.createHash('sha256').update(text).digest('hex')}};
  } catch (e) {
    return {output: {code: e.code != null ? e.code : null, message: String(e.message)}};
  }
};
