// Run through a linked spelling of the install (test/fs-broker/27): the
// first process relaunches itself under --permission as framework.js does
// (lib/hardened-launch.js relaunch); the relaunched one prints the links it
// was handed and what the broker protects.
//   node --preserve-symlinks --preserve-symlinks-main relaunch-links.js <options JSON> <grant>...
const path = require('path');
const LIB = path.join(__dirname, '..', '..', '..', 'lib');
const realpaths = require(path.join(LIB, 'hardened-realpaths'));

if (process.permission == null) {
  // the unrestricted parent: it finds the links, as precompute does
  const options = JSON.parse(process.argv[2]);
  const broker = require(path.join(LIB, 'fs-broker'));
  broker.protectedPaths(options);
  const flags = ['--permission'].concat(process.argv.slice(3).map((g) => `--allow-fs-read=${g}`));
  require(path.join(LIB, 'hardened-launch')).relaunch(flags, {});
} else {
  realpaths.receive();
  const broker = require(path.join(LIB, 'fs-broker'));
  let above = 'allowed';
  try { require('fs').lstatSync(path.parse(LIB).root); } catch (e) { above = e.code; }
  console.log(JSON.stringify({handed: realpaths.installLinks(), protectedPaths: broker.protectedPaths(JSON.parse(process.argv[2])), lstatAboveGrants: above}));
}
