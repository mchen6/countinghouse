// One of hop-input-callee's actions, over whichever path the server uses
// (test/sandbox/49): its result's length and sha256 (never echoed whole), or
// the rejection's code and message.
const crypto = require('crypto');
module.exports = async (input, ctx) => {
  try {
    const result = await ctx.call(`hop-input-callee/sinkService.${input.action}`, input.args);
    const text = JSON.stringify(result);
    return {output: {length: text.length, sha256: crypto.createHash('sha256').update(text).digest('hex')}};
  } catch (e) {
    return {output: {code: e.code != null ? e.code : null, message: String(e.message)}};
  }
};
