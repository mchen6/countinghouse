// Run as the runtime might be (test/fs-broker/27): through a linked
// spelling of the install, started through a link to this file, or told by
// its launcher how it was started (COUNTINGHOUSE_STARTED_FROM). Prints where
// the broker takes its install to be, the links it protects for the spawn
// options given, its protected paths, and the server's own paths' links.
//   node [--preserve-symlinks --preserve-symlinks-main] links-print.js <spawn options JSON> [<server options JSON>]
const path = require('path');
const LIB = path.join(__dirname, '..', '..', '..', 'lib');
// the server's own options, as framework.js sets them from its command line
if (process.argv[3] != null) Object.assign(require(path.join(LIB, 'cli-options')), JSON.parse(process.argv[3]));
const broker = require(path.join(LIB, 'fs-broker'));

const options = JSON.parse(process.argv[2]);
console.log(JSON.stringify({install: broker.INSTALL_DIR, links: broker.protectedLinks(options), protectedPaths: broker.protectedPaths(options),
  server: broker.serverLinkPlaces()}));
