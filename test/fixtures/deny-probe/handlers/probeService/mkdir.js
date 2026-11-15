// mkdir.js -- makes input.path with the module's fs: ok, or the error code.
module.exports = async (input) => {
  try {
    require('fs').mkdirSync(input.path);
    return {output: {ok: true, code: null}};
  } catch (e) {
    return {output: {ok: false, code: String(e.code)}};
  }
};
