// The operator's --modulePolicy file: ceilings for every module and per-module
// entries that narrow a module's declared permissions
// (lib/module-permissions.js#narrow). Loaded at startup to fail fast, and
// again on every module spawn so an edit takes effect on module restart.
const fs = require('fs');

const EMPTY = Object.freeze({limits: {}, modules: {}});

function fail(where, message) {
  throw new Error(`--modulePolicy: ${where} ${message}`);
}

function checkArray(v, where) {
  if (v != null && !Array.isArray(v)) fail(where, 'must be an array');
}

function checkObject(v, where) {
  if (v != null && (typeof(v) !== 'object' || Array.isArray(v))) fail(where, 'must be an object');
}

function load(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`--modulePolicy: cannot read ${file}: ${e.message}`);
  }
  checkObject(raw, 'the file');
  checkObject(raw.limits, 'limits');
  checkObject(raw.modules, 'modules');
  const modules = raw.modules || {};
  Object.keys(modules).forEach((name) => {
    const e = modules[name];
    checkObject(e, `modules.${name}`);
    if (e.approve != null && e.approve !== 'as-declared') fail(`modules.${name}.approve`, 'must be "as-declared"');
    checkArray(e.fs, `modules.${name}.fs`);
    checkArray(e.net, `modules.${name}.net`);
    checkObject(e.env, `modules.${name}.env`);
    checkObject(e.limits, `modules.${name}.limits`);
  });
  return {limits: raw.limits || {}, modules: modules};
}

module.exports = {EMPTY, load};
