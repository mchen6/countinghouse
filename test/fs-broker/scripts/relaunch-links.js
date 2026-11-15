// Run through a linked spelling of the install (test/fs-broker/27): the
// first process sets the server's options and relaunches itself under
// --permission as framework.js does (lib/hardened-launch.js relaunch),
// which finds the links while it may look; the relaunched one prints the
// links it was handed and the ones the broker goes by for a spawn.
//   node --preserve-symlinks --preserve-symlinks-main relaunch-links.js <server options JSON> <spawn options JSON> <grant>...
const path = require('path');
const LIB = path.join(__dirname, '..', '..', '..', 'lib');
const realpaths = require(path.join(LIB, 'hardened-realpaths'));
Object.assign(require(path.join(LIB, 'cli-options')), JSON.parse(process.argv[2]));

if (process.permission == null) {
  const flags = ['--permission'].concat(process.argv.slice(4).map((g) => `--allow-fs-read=${g}`));
  require(path.join(LIB, 'hardened-launch')).relaunch(flags, {});
} else {
  realpaths.receive();
  let above = 'allowed';
  try { require('fs').lstatSync(path.parse(LIB).root); } catch (e) { above = e.code; }
  const unchecked = [];
  const links = require(path.join(LIB, 'fs-broker')).protectedLinks(JSON.parse(process.argv[3]), (p) => unchecked.push(p));
  console.log(JSON.stringify({handed: realpaths.linkPlaces(), links, unchecked, lstatAboveGrants: above}));
}
