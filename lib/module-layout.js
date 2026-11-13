// One module format (lean worker, step 1; Matt, 2026-11-13): a module is
// api.json, schema.json and handlers/<service>/<action>.js. Decided from
// static facts, before any of the module's code runs: on the main thread
// before a worker starts, in the thread that instantiates the module, and in
// countinghouse-validate. A main entry (package.json "main", or the index.js
// Node would default to) with no handlers/ directory is the retired CDIF
// style, a constructor or a handler map exported from device.js or index.js,
// and is refused. With a handlers/ directory, a main entry is never run.
'use strict';

const fs   = require('fs');
const {CountinghouseError} = require('./countinghouse-error');

// The path module for `modulePath`: in a module worker it is /app, POSIX on
// every OS (lib/fs-broker/identity.js, issue #40).
const pathOf = (modulePath) => require('./fs-broker/identity').pathFor(modulePath);

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// -> what makes a main entry, as read, or null: a "main" in package.json
// (whatever it names), or an index.js. An unreadable package.json counts as
// no "main"; the load reports that itself.
function mainEntry(modulePath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pathOf(modulePath).join(modulePath, 'package.json'), 'utf8'));
    if (pkg != null && typeof(pkg.main) === 'string' && pkg.main.trim() !== '') return `package.json "main": ${JSON.stringify(pkg.main)}`;
  } catch (e) { /* no "main" to go by */ }
  return fs.existsSync(pathOf(modulePath).join(modulePath, 'index.js')) ? 'index.js' : null;
}

// -> whether modulePath has a handlers/ directory.
function hasHandlers(modulePath) {
  return isDirectory(pathOf(modulePath).join(modulePath, 'handlers'));
}

// -> null when the layout is the module format, or the
// MODULE_LAYOUT_UNSUPPORTED error to answer with: a main entry and no
// handlers/ directory, naming what it read. A module with neither is left to
// the load's own errors (no handler map found).
function layoutRefusal(modulePath, name) {
  if (hasHandlers(modulePath)) return null;
  const main = mainEntry(modulePath);
  if (main == null) return null;
  return CountinghouseError.withFields('MODULE_LAYOUT_UNSUPPORTED', {name: String(name), file: main});
}

module.exports = {layoutRefusal, hasHandlers, mainEntry};
