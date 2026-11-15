// Run through a linked spelling of the install (test/fs-broker/27): the
// first process does what framework.js does under --hardened -- the real
// paths and the links found while it may look (lib/hardened-launch.js
// precompute), then the relaunch under --permission; the relaunched one
// prints the links it was handed and the ones the broker goes by.
//   node --preserve-symlinks --preserve-symlinks-main relaunch-links.js <options JSON> <grant>...
const path = require('path');
const LIB = path.join(__dirname, '..', '..', '..', 'lib');
const realpaths = require(path.join(LIB, 'hardened-realpaths'));
const options = JSON.parse(process.argv[2]);

if (process.permission == null) {
  const launch = require(path.join(LIB, 'hardened-launch'));
  const rec = realpaths.recorder(require('fs').realpathSync.native);
  launch.precompute(options, path.join(LIB, '..'), rec);
  const flags = ['--permission'].concat(process.argv.slice(3).map((g) => `--allow-fs-read=${g}`));
  launch.relaunch(flags, rec.known());
} else {
  realpaths.receive();
  let above = 'allowed';
  try { require('fs').lstatSync(path.parse(LIB).root); } catch (e) { above = e.code; }
  console.log(JSON.stringify({handed: realpaths.linkPlaces(), links: require(path.join(LIB, 'fs-broker')).protectedLinks(options), lstatAboveGrants: above}));
}
