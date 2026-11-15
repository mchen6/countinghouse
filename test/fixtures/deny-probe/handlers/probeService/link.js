// link.js -- makes a hard link at input.to of input.from with the module's fs: ok, or the error code.
module.exports = async (input) => {
  try {
    require('fs').linkSync(input.from, input.to);
    return {output: {ok: true, code: null}};
  } catch (e) {
    return {output: {ok: false, code: String(e.code)}};
  }
};
