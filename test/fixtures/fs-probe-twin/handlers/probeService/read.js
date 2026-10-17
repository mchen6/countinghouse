// read.js -- reads input.path with the module's fs.
module.exports = async (input) => {
  try {
    return {output: {content: require('fs').readFileSync(input.path, 'utf8'), code: null}};
  } catch (e) {
    return {output: {content: null, code: String(e.code)}};
  }
};
