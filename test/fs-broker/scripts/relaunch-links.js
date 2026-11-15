// Run through a linked spelling of the install (test/fs-broker/27): the
// first process relaunches itself under --permission as framework.js does
// (lib/hardened-launch.js relaunch); the relaunched one prints the links it
// was handed and the ones the broker goes by.
//   node --preserve-symlinks --preserve-symlinks-main relaunch-links.js <grant>...
const path = require('path');
const LIB = path.join(__dirname, '..', '..', '..', 'lib');
const realpaths = require(path.join(LIB, 'hardened-realpaths'));

if (process.permission == null) {
  // the unrestricted parent, which can look
  const flags = ['--permission'].concat(process.argv.slice(2).map((g) => `--allow-fs-read=${g}`));
  require(path.join(LIB, 'hardened-launch')).relaunch(flags, {});
} else {
  realpaths.receive();
  let above = 'allowed';
  try { require('fs').lstatSync(path.parse(LIB).root); } catch (e) { above = e.code; }
  console.log(JSON.stringify({handed: realpaths.installLinks(), links: require(path.join(LIB, 'fs-broker')).installLinkPlaces(), lstatAboveGrants: above}));
}
