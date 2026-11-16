// chmod.js -- sets input.path's mode to 0o600 with the module's fs: ok, or the error code.
module.exports = async (input) => {
  try {
    require('fs').chmodSync(input.path, 0o600);
    return {output: {ok: true, code: null}};
  } catch (e) {
    return {output: {ok: false, code: String(e.code)}};
  }
};
