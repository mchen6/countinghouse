'use strict';
// The kernel's real path, as the runtime decides confinement on it
// (lib/hardened-realpaths.js: fs.realpathSync.native). A test that compares
// a path the runtime resolved uses this, never Node's JS fs.realpathSync:
// on windows-latest os.tmpdir() is an 8.3 path (RUNNER~1) that the native
// form expands and the JS form keeps (the Reviewer's high review of #441).
const fs = require('fs');

const realPath = (p) => fs.realpathSync.native(p);

module.exports = {realPath};
