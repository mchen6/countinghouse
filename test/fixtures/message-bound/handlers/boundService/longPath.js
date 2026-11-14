// A file outside the module, named by a path of 2 000 000 characters, through
// CHUtil.loadFile: the lockdown refuses it, and its report must not be lost
// to its own size.
module.exports = async () => {
  try {
    CHUtil.loadFile(`/etc/${'a'.repeat(2000000)}`);
    return {output: {refused: false, code: null}};
  } catch (e) {
    return {output: {refused: true, code: e.code || null}};
  }
};
