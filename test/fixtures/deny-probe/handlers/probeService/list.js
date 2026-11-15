// list.js -- lists input.path recursively with the module's fs: the names, or the error code.
module.exports = async (input) => {
  try {
    return {output: {names: require('fs').readdirSync(input.path, {recursive: true}).map(String), code: null}};
  } catch (e) {
    return {output: {names: null, code: String(e.code)}};
  }
};
