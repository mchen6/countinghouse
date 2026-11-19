'use strict';
// The module form's dirs (#413 rev 3, section 7.3) for a top-level module
// laid out as ch-local laid out a pack: every module beside it in its
// node_modules, by its package name (M6; one helper, #455's high review, 7).
// top: the top-level module's directory. -> {'<package>': '<dir>', ...}
const fs = require('fs');
const path = require('path');

function dirsOf(top) {
  let nm = path.dirname(top);
  // (a scoped package: its scope's parent holds the others)
  if (path.basename(nm).startsWith('@')) nm = path.dirname(nm);
  const out = {};
  for (const n of fs.readdirSync(nm)) {
    if (n.startsWith('@')) for (const m of fs.readdirSync(path.join(nm, n))) out[`${n}/${m}`] = path.join(nm, n, m);
    else out[n] = path.join(nm, n);
  }
  return out;
}

module.exports = {dirsOf};
