// fsResults.js -- paths the module's fs returns, and how it treats a symlink
// target and a relative path (single-thread mode translates these).
const fs = require('fs');
module.exports = async () => {
  fs.writeFileSync('/data/x', 'x');
  const out = {
    realpath: fs.realpathSync('/data'),
    mkdtemp: fs.mkdtempSync('/tmp/x-').replace(/x-.*$/, 'x-*'),
    parent: fs.readdirSync('/data', {withFileTypes: true})[0].parentPath,
    relative: fs.existsSync('package.json'),
    mkdirFirst: fs.mkdirSync('/data/a/b', {recursive: true})
  };
  fs.symlinkSync('/data/x', '/data/l');
  return {output: out};
};
