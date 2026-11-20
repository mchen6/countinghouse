// symlink.js -- makes a symlink at input.path to input.target with the module's fs: ok, or the error code.
module.exports = async (input) => {
  try {
    require('fs').symlinkSync(input.target, input.path);
    return {output: {ok: true, code: null}};
  } catch (e) {
    return {output: {ok: false, code: String(e.code)}};
  }
};
