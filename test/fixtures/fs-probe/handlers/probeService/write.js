// write.js -- writes input.content to input.path with the module's fs.
module.exports = async (input) => {
  try {
    require('fs').writeFileSync(input.path, input.content);
    return {output: {ok: true, code: null}};
  } catch (e) {
    return {output: {ok: false, code: String(e.code)}};
  }
};
