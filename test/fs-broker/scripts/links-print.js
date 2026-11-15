// Run as the runtime might be (test/fs-broker/27): through a linked
// spelling of the install, or started through a link to this file. Prints
// where the broker takes its install to be, the links it protects for the
// options given, and its protected paths.
//   node [--preserve-symlinks --preserve-symlinks-main] links-print.js <options JSON>
const path = require('path');
const broker = require(path.join(__dirname, '..', '..', '..', 'lib', 'fs-broker'));

const options = JSON.parse(process.argv[2]);
console.log(JSON.stringify({install: broker.INSTALL_DIR, links: broker.protectedLinks(options), protectedPaths: broker.protectedPaths(options)}));
