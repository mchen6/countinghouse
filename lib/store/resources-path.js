'use strict';
// Where the result store's local files live, and whether a module could
// reach them there (MCP completeness M5). No dependencies of its own:
// lib/cli-options.js checks it at start (exit 2), lib/store/blobs-local.js
// again when it opens.
const fs = require('fs');
const path = require('path');

const resourcesDir = (storePath) => path.join(path.resolve(storePath), 'resources');

function under(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function realOrResolved(p) {
  try { return fs.realpathSync.native(p); } catch (e) { return path.resolve(p); }
}

// -> why <storePath>/resources must not be used, or null
function resourcesProblem(storePath, moduleDataPath) {
  const dir = resourcesDir(storePath);
  if (moduleDataPath != null && under(realOrResolved(dir), realOrResolved(moduleDataPath))) {
    return `${dir} is under the module data path (${moduleDataPath}), where a module could reach it`;
  }
  return null;
}

module.exports = {resourcesDir, resourcesProblem};
