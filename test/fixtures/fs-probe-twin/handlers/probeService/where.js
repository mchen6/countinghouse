// where.js -- what a module sees of its own location, and a read built from __dirname.
const path = require('path');
module.exports = async () => {
  let frame;
  try { throw new Error('x'); } catch (e) { frame = e.stack.split('\n')[1].trim(); }
  let own;
  try { own = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).name; } catch (e) { own = String(e.code); }
  return {output: {dirname: __dirname, filename: __filename, cwd: process.cwd(), tmpdir: require('os').tmpdir(),
    resolve: require.resolve('./read'), frame: frame, own: own,
    // a require built from a directory, as some packages do (worker mode
    // only: single-thread mode does not map a virtual createRequire path)
    dirResolve: (() => { try { return require('module').createRequire(`${__dirname}/`).resolve('./read'); } catch (e) { return String(e.code); } })()}};
};
