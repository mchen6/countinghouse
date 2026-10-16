// The operator's --modulePolicy file: ceilings for every module and per-module
// entries that narrow a module's declared permissions
// (lib/module-permissions.js#narrow). Loaded at startup to fail fast, and
// again on every module spawn so an edit takes effect on module restart.
const fs = require('fs');

const LIMIT_KEYS = ['heapMb', 'externalMb', 'maxBlockMs'];
const EMPTY = Object.freeze({limits: Object.freeze({}), modules: Object.freeze(Object.create(null))});

function fail(where, message) {
  throw new Error(`--modulePolicy: ${where} ${message}`);
}

function checkArray(v, where) {
  if (v != null && !Array.isArray(v)) fail(where, 'must be an array');
}

function checkObject(v, where, isRequired = false) {
  if (isRequired && v == null) fail(where, 'must be an object');
  if (v != null && (typeof(v) !== 'object' || Array.isArray(v))) fail(where, 'must be an object');
}

function validateLimits(limits, where) {
  if (limits == null) return;
  if (typeof(limits) !== 'object' || Array.isArray(limits)) fail(where, 'must be an object');
  Object.keys(limits).forEach((k) => {
    if (LIMIT_KEYS.indexOf(k) === -1) fail(`${where}.${k}`, `is not a known limit (${LIMIT_KEYS.join(', ')})`);
    if (!Number.isInteger(limits[k]) || limits[k] <= 0) fail(`${where}.${k}`, 'must be a positive integer');
  });
}

function load(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`--modulePolicy: cannot read ${file}: ${e.message}`);
  }
  checkObject(raw, 'the file', true);
  validateLimits(raw.limits, 'limits');
  checkObject(raw.modules, 'modules', false);
  const modules = Object.create(null);
  Object.keys(raw.modules || {}).forEach((name) => {
    const e = raw.modules[name];
    checkObject(e, `modules.${name}`, true);
    if (e.approve != null && e.approve !== 'as-declared') fail(`modules.${name}.approve`, 'must be "as-declared"');
    checkArray(e.fs, `modules.${name}.fs`);
    checkArray(e.net, `modules.${name}.net`);
    checkObject(e.env, `modules.${name}.env`);
    validateLimits(e.limits, `modules.${name}.limits`);
    modules[name] = e;
  });
  return {limits: raw.limits || {}, modules: modules};
}

module.exports = {EMPTY, load};
