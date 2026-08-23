// The authoring oracle: a module directory in, a structured problem list out,
// with no Redis, no worker and no running server.
//
// Every check here already existed -- lib/handler-map.js's strict both-way
// check and lib/validator.js's meta-schema validation. What did not exist was
// a way to reach them without booting framework.js, which initialises Redis at
// startup. Authoring is a fix-check-fix loop, for humans and for agents, and a
// loop whose check needs a database is a loop nobody runs.
//
// Messages are passed through byte-identical. This module adds structure
// around them; it deliberately does not reword them, so the text an author
// sees here is the text the server logs.
const fs   = require('fs');
const path = require('path');

const handlerMapLib    = require('./handler-map');
const handlerMapModule = require('./handler-map-module');
const validator        = require('./validator');

function problem(stage, moduleName, message, fix) {
  return {stage: stage, module: moduleName, message: message, fix: fix || null};
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file).toString());
}

// The module's main entry, or null when it has none or it throws. A module in
// the 6.0.0 convention shape (handlers/ directory) legitimately has no main
// entry worth loading, so this failing is not itself a problem -- only a
// handler map that cannot be resolved *at all* is.
//
// `entryExists` distinguishes the two reasons require() can fail here: a
// convention module with no index.js on disk at all (package.json has no
// "main", and the default "index.js" was never supposed to exist -- normal,
// stays silent) from a main entry file that is *present* and throws while
// being required (a real bug the caller must report). require.resolve() is
// used to answer that ahead of the actual require() call, since it runs
// Node's module resolution without executing the file's code.
function loadExported(modulePath) {
  let pkg = null;
  try {
    pkg = readJSON(path.join(modulePath, 'package.json'));
  } catch (e) {
    return {exported: null, pkgError: e.message};
  }

  const main = pkg.main || 'index.js';
  const entryPath = path.join(modulePath, main);

  let entryExists = false;
  try {
    require.resolve(entryPath);
    entryExists = true;
  } catch (e) {
    entryExists = false;
  }

  try {
    return {exported: require(entryPath), pkgError: null, name: pkg.name};
  } catch (e) {
    return {
      exported: null, pkgError: null, name: pkg.name,
      requireError: e.message, entryExists: entryExists, entryPath: entryPath
    };
  }
}

// Spec problems are reported one per ajv error so each carries its own
// instancePath -- a single joined string is what made "invalid spec" unhelpful
// in the first place (see lib/device-manager.js's validateDeviceSpec branch).
function specProblems(err, moduleName) {
  if (Array.isArray(err.validationErrors) && err.validationErrors.length > 0) {
    return err.validationErrors.map((e) => {
      return problem('validateDeviceSpec', moduleName,
        `${e.instancePath}: ${e.message}`,
        'Fix the named path in api.json, or its schema.json pointer.');
    });
  }
  return [problem('validateDeviceSpec', moduleName, err.message, null)];
}

function validateModule(modulePath, callback) {
  const resolved = path.resolve(modulePath);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return callback(new Error(`${resolved} is not a directory`));
  }

  const loaded     = loadExported(resolved);
  const moduleName = loaded.name || path.basename(resolved);
  const problems   = [];

  if (loaded.pkgError != null) {
    problems.push(problem('readPackageJson', moduleName,
      `package.json could not be read: ${loaded.pkgError}`,
      'Every module needs a package.json with a name.'));
  }

  // Only a main entry that *exists on disk* and throws is a real problem.
  // A convention module legitimately has no index.js -- package.json may
  // have no "main", the default "index.js" does not exist, and require()
  // throws MODULE_NOT_FOUND for a file that was never supposed to exist.
  // That must stay silent; resolveHandlerMap below does not depend on this
  // file, so the module can still be entirely valid without it.
  if (loaded.entryExists && loaded.requireError != null) {
    problems.push(problem('loadModuleEntry', moduleName,
      `${loaded.entryPath} exists but threw while being required: ${loaded.requireError}. ` +
      'This may be a genuine bug in the module, or the module may depend on something ' +
      'only present in the real server load path.',
      'If this module references CHUtil or CHDevice directly, it may be written for the ' +
      'sandboxed load path, where lib/sandbox.js sets those as globals before requiring ' +
      'the module -- they are not set here or by a plain require(). Otherwise, fix the ' +
      'exception at the top of the main entry file.'));
  }

  let spec = null;
  const apiPath = path.join(resolved, 'api.json');
  try {
    spec = readJSON(apiPath);
  } catch (e) {
    problems.push(problem('readApiJson', moduleName,
      `${apiPath} could not be read: ${e.message}`,
      'api.json declares the device, its services and their actions.'));
    return callback(null, {ok: false, module: moduleName, problems: problems});
  }

  // schema.json is optional, but present-and-malformed is not legal
  try {
    handlerMapModule.readRootSchema(resolved, moduleName);
  } catch (e) {
    problems.push(problem('readRootSchema', moduleName, e.message,
      'schema.json must be valid JSON when present.'));
  }

  let resolvedMap = null;
  try {
    resolvedMap = handlerMapModule.resolveHandlerMap(resolved, loaded.exported, (f) => require(f));
  } catch (e) {
    problems.push(problem('resolveHandlerMap', moduleName,
      `handler map could not be loaded: ${e.message}`,
      'A handler file threw while being required.'));
  }

  if (resolvedMap == null) {
    problems.push(problem('resolveHandlerMap', moduleName,
      `${moduleName}: no handler map found -- neither a handlers/ directory nor a handler-map export.`,
      'This may be a legacy discovery-style module, which the runtime still ' +
      'supports but this validator cannot check beyond its spec.'));
  } else {
    handlerMapLib.validateHandlerMap(spec, resolvedMap.handlerMap, moduleName)
      .forEach((message) => {
        problems.push(problem('assembleHandlerMap', moduleName, message, null));
      });
  }

  return validator.validateDeviceSpec(spec, (specErr) => {
    if (specErr != null) specProblems(specErr, moduleName).forEach((p) => problems.push(p));
    return callback(null, {ok: problems.length === 0, module: moduleName, problems: problems});
  });
}

module.exports = {
  validateModule: validateModule
};
