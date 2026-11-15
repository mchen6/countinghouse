// remove.js -- removes input.path (recursively) with the module's fs: ok, or the error code.
module.exports = async (input) => {
  try {
    require('fs').rmSync(input.path, {recursive: true, force: false});
    return {output: {ok: true, code: null}};
  } catch (e) {
    return {output: {ok: false, code: String(e.code)}};
  }
};
