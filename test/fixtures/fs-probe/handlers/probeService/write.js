// write.js -- writes input.content (repeated input.repeat times, so a test can
// write megabytes without sending them) to input.path with the module's fs.
module.exports = async (input) => {
  try {
    require('fs').writeFileSync(input.path, input.repeat != null ? input.content.repeat(input.repeat) : input.content);
    return {output: {ok: true, code: null}};
  } catch (e) {
    return {output: {ok: false, code: String(e.code)}};
  }
};
