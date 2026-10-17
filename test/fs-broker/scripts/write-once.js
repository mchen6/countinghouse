// One writeFileSync and one appendFileSync to /data, for the op-budget test.
module.exports = async (fs, root) => {
  fs.writeFileSync(`${root}/x`, 'hello');
  fs.appendFileSync(`${root}/x`, ' world');
  return fs.readFileSync(`${root}/x`, 'utf8');
};
