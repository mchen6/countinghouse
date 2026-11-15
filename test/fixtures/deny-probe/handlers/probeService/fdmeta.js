// fdmeta.js -- opens input.path read-only with the module's fs and tries each
// change a descriptor can make: the error code of each, or 'ok'.
module.exports = async (input) => {
  const fs = require('fs');
  let fd;
  try { fd = fs.openSync(input.path, 'r'); } catch (e) { return {output: {open: String(e.code)}}; }
  const tryIt = (f) => { try { f(); return 'ok'; } catch (e) { return String(e.code); } };
  const st = fs.fstatSync(fd);
  const out = {open: 'ok',
    fchmod: tryIt(() => fs.fchmodSync(fd, 0o777)),
    fchown: tryIt(() => fs.fchownSync(fd, st.uid, st.gid)),
    futimes: tryIt(() => fs.futimesSync(fd, 1, 1)),
    ftruncate: tryIt(() => fs.ftruncateSync(fd, 0)),
    write: tryIt(() => fs.writeSync(fd, 'x'))};
  fs.closeSync(fd);
  return {output: out};
};
