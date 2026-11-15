// rename.js -- renames input.from to input.to with the module's fs: ok, or the error code.
module.exports = async (input) => {
  try {
    require('fs').renameSync(input.from, input.to);
    return {output: {ok: true, code: null}};
  } catch (e) {
    return {output: {ok: false, code: String(e.code)}};
  }
};
