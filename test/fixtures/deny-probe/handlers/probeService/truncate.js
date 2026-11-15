// truncate.js -- truncates input.path to 0 bytes with the module's fs: ok, or the error code.
module.exports = async (input) => {
  try {
    require('fs').truncateSync(input.path, 0);
    return {output: {ok: true, code: null}};
  } catch (e) {
    return {output: {ok: false, code: String(e.code)}};
  }
};
