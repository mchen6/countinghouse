// Run through a linked spelling of the install (test/fs-broker/27): the
// first process sets the server's options and relaunches itself under
// --permission as framework.js does (lib/hardened-launch.js relaunch),
// which finds the links while it may look; the relaunched one prints what
// it was handed, the names the broker goes by for a spawn, and what a spawn
// with a path nothing was handed for is told.
//   node --preserve-symlinks --preserve-symlinks-main relaunch-links.js <server options JSON> <spawn options JSON> <stray spawn options JSON> <grant>...
const path = require('path');
const LIB = path.join(__dirname, '..', '..', '..', 'lib');
const realpaths = require(path.join(LIB, 'hardened-realpaths'));
Object.assign(require(path.join(LIB, 'cli-options')), JSON.parse(process.argv[2]));

if (process.permission == null) {
  const flags = ['--permission'].concat(process.argv.slice(5).map((g) => `--allow-fs-read=${g}`));
  require(path.join(LIB, 'hardened-launch')).relaunch(flags, {});
} else {
  realpaths.receive();
  let above = 'allowed';
  try { require('fs').lstatSync(path.parse(LIB).root); } catch (e) { above = e.code; }
  const broker = require(path.join(LIB, 'fs-broker'));
  let stray;
  try { broker.protectedLinks(JSON.parse(process.argv[4])); stray = ['went on']; } catch (e) { stray = [e.code, e.message]; }
  console.log(JSON.stringify({handed: realpaths.linkPlaces(), links: broker.protectedLinks(JSON.parse(process.argv[3])), stray,
    startProblem: require(path.join(LIB, 'hardened-launch')).startProblem(), lstatAboveGrants: above}));
}
