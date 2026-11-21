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

// Whether a stat (or a {dev, ino} identity) names a file exactly: dev and
// ino read with BIG, and an ino a volume really gave (0, or none, is "cannot
// tell": a volume that reports index 0 would pass any comparison --
// the pre-work high on #513, F6).
const known = (x) => x != null && typeof(x.dev) === 'bigint' && typeof(x.ino) === 'bigint' && x.ino !== 0n;

// Whether two stats (or identities) name one file: both known, and equal.
// One that cannot tell is never the same file -- every check that passes
// on "the same" fails closed.
function sameFile(a, b) {
  return known(a) && known(b) && a.dev === b.dev && a.ino === b.ino;
}

// Whether two stats (or identities) name different files: both known, and
// unequal. One that cannot tell is neither -- what gives back on "different"
// (a rename's quota) gives nothing back.
function differentFile(a, b) {
  return known(a) && known(b) && (a.dev !== b.dev || a.ino !== b.ino);
}

// An lstat that reads identity exactly.
const identStat = (p) => fsp.lstat(p, BIG);
const identStatSync = (p) => fs.lstatSync(p, BIG);

module.exports = {BIG, fileKey, sameFile, differentFile, identStat, identStatSync};
