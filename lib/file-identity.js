'use strict';
// A file's identity, exact. dev and ino are read as bigints: a Windows file
// index can be past 2^53, where a Number loses its low bits and two files
// would compare alike (#456). Every same-file comparison and "dev:ino" key
// in the runtime goes through here: the file broker's open check, rename
// and removal quota, its denied set and spawn walk; an icon read; the run
// directory; the settings lock and file stamps.
const fs = require('fs');
const fsp = require('fs/promises');

// the stat options that read dev and ino exactly
const BIG = Object.freeze({bigint: true});

// A stat's "dev:ino", from a stat read with BIG (a Number one's digits
// would be its rounded value).
function fileKey(st) {
  return `${st.dev}:${st.ino}`;
}

// Whether two stats (or {dev, ino} identities), both read with BIG, name one
// file.
function sameFile(a, b) {
  return a != null && b != null && a.dev === b.dev && a.ino === b.ino;
}

// An lstat that reads identity exactly.
const identStat = (p) => fsp.lstat(p, BIG);
const identStatSync = (p) => fs.lstatSync(p, BIG);

module.exports = {BIG, fileKey, sameFile, identStat, identStatSync};
