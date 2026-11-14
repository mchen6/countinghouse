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
const callAddress      = require('./call-address');
const modulePermissions = require('./module-permissions');
const moduleTreeCheck   = require('./module-tree-check');
const remoteDeclaration = require('./remote/declaration');
const moduleLayout      = require('./module-layout');

// A module's files, as countinghouse code must name them: inside a sandboxed
// validation worker (review R1-4) the module is /app, reached through the
// identity hook's module specifier; elsewhere (the CLI, the child process) the
// path itself.
const specifierFor = (p) => require('./fs-broker/identity').specifierFor(p);
const requireModuleFile = (p) => require(specifierFor(p));

// code: the runtime's error code, where the load answers with one too
// (MODULE_LAYOUT_UNSUPPORTED), so a caller matches it without the text.
function problem(stage, moduleName, message, fix, code) {
  const p = {stage: stage, module: moduleName, message: message, fix: fix || null};
  if (code != null) p.code = code;
  return p;
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file).toString());
}

// The module's package.json. No module code is required here: a module is
// api.json, schema.json and handlers/ (lib/module-layout.js), and a main
// entry is never run, by the validator or the runtime.
function readPackage(modulePath) {
  try {
    const pkg = readJSON(require('./fs-broker/identity').pathFor(modulePath).join(modulePath, 'package.json'));
    return {pkg: pkg, name: pkg.name, pkgError: null};
  } catch (e) {
    return {pkg: null, name: null, pkgError: e.message};
  }
}

// Syntax-only check of package.json's "countinghouse.calls" declarations.
// There is no server and nothing loaded here, so this can confirm an address
// is *shaped* like `<module>/<service>.<action>` and free of duplicates, but
// it cannot know whether the named module, service or action actually
// exists -- that is left to load time (DeviceManager's verifyComposition)
// and, for a plan, to lib/plan-validator.js when it has live targets to
// check against.
function callsProblems(pkg, moduleName) {
  const problems = [];
  const calls = (pkg != null && pkg.countinghouse != null) ? pkg.countinghouse.calls : null;
  if (calls == null) return problems;

  if (!Array.isArray(calls)) {
    problems.push(problem('countinghouse.calls', moduleName,
      'countinghouse.calls must be an array of composition address strings.',
      `Each entry names a target this module may call, in ${callAddress.ADDRESS_FORM} form.`));
    return problems;
  }

  const seen = {};
  calls.forEach((address) => {
    if (seen[address] === true) {
      problems.push(problem('countinghouse.calls', moduleName,
        `countinghouse.calls lists "${address}" more than once.`,
        'Remove the duplicate entry.'));
    }
    seen[address] = true;

    if (callAddress.parseAddress(address) == null) {
      problems.push(problem('countinghouse.calls', moduleName,
        `"${address}" is not a valid composition address -- expected ${callAddress.ADDRESS_FORM}.`,
        'This only checks the address shape -- whether the target module, service and ' +
        'action actually exist is resolved when this module is loaded, not here.'));
    }
  });

  return problems;
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
  // a module worker validates /app, POSIX on every OS (identity.pathFor; issue #40)
  const resolved = require('./fs-broker/identity').pathFor(modulePath).resolve(modulePath);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return callback(new Error(`${resolved} is not a directory`));
  }

  const loaded     = readPackage(resolved);
  const moduleName = loaded.name || path.basename(resolved);
  const problems   = [];
  const warnings   = [];

  if (loaded.pkgError != null) {
    problems.push(problem('readPackageJson', moduleName,
      `package.json could not be read: ${loaded.pkgError}`,
      'Every module needs a package.json with a name.'));
  }

  // One module format (lib/module-layout.js), the load's own rule and text.
  const layout = moduleLayout.layoutRefusal(resolved, moduleName);
  if (layout != null) {
    problems.push(problem('layout', moduleName, layout.message,
      'Move each action into handlers/<service>/<action>.js and remove the main entry. ' +
      'See docs/module-development.md.', layout.code));
  } else if (moduleLayout.hasHandlers(resolved) && moduleLayout.mainEntry(resolved) != null) {
    // Not a problem: the module loads from handlers/. But whatever the main
    // entry does (a handler map it exports included) never happens.
    warnings.push(problem('layout', moduleName,
      `${moduleLayout.mainEntry(resolved)} is never run: the module loads from handlers/`,
      'Remove the main entry, or move what it does into a handler file. See docs/module-development.md.'));
  }

  callsProblems(loaded.pkg, moduleName).forEach((p) => problems.push(p));

  // Module sandbox checks (lib/module-permissions.js, lib/module-tree-check.js).
  // The same checks run again at load time, which is the one that decides.
  const declaration = modulePermissions.parseDeclaration(loaded.pkg);
  declaration.problems.forEach((message) => {
    problems.push(problem('countinghouse.permissions', moduleName, message,
      'See "Declaring permissions" in docs/module-development.md.'));
  });
  // A COUNTINGHOUSE_* name is never handed over (lib/module-permissions.js):
  // the declaration is not an error, it just does nothing.
  modulePermissions.deniedEnvNames(declaration.declared.env).forEach((name) => {
    warnings.push(problem('countinghouse.permissions', moduleName,
      `countinghouse.permissions.env names ${name}: COUNTINGHOUSE_* is never handed to a module, so the declaration has no effect`,
      'Remove it from the declaration.'));
  });
  // RC1-min: the remote MCP server (lib/remote/declaration.js). The
  // validator knows neither --debug nor the Redis endpoint, so it checks
  // the production rules, the stricter ones; the load checks again.
  remoteDeclaration.parseRemotes(loaded.pkg, {debug: false, redisEndpoint: null}).problems.forEach((message) => {
    problems.push(problem('countinghouse.remotes', moduleName, message,
      'See "Declaring a remote MCP server" in docs/module-development.md.'));
  });
  const tree = moduleTreeCheck.checkTree(resolved);
  tree.problems.forEach((message) => problems.push(problem('checkTree', moduleName, message, null)));
  tree.warnings.forEach((message) => warnings.push(problem('checkTree', moduleName, message, null)));

  let spec = null;
  const apiPath = path.join(resolved, 'api.json');
  try {
    spec = readJSON(apiPath);
  } catch (e) {
    problems.push(problem('readApiJson', moduleName,
      `${apiPath} could not be read: ${e.message}`,
      'api.json declares the device, its services and their actions.'));
    return callback(null, {ok: false, module: moduleName, problems: problems, warnings: warnings});
  }

  // The CDIF-era device fields rateLimit and price are retired (S1): nothing
  // reads them, and the schema still accepts them (device is not closed), so
  // a spec carrying one is warned about rather than refused.
  const RETIRED_DEVICE_FIELDS = {
    rateLimit: '`rateLimit` is no longer read; use --apiKeyRateLimit or --globalRateLimit',
    price: '`price` is no longer read'
  };
  if (spec != null && spec.device != null) {
    Object.keys(RETIRED_DEVICE_FIELDS).forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(spec.device, k)) {
        warnings.push(problem('readApiJson', moduleName, RETIRED_DEVICE_FIELDS[k],
          'Remove it from api.json (bin/countinghouse-migrate-spec.js removes both).'));
      }
    });
  }

  // schema.json is optional, but present-and-malformed is not legal
  try {
    handlerMapModule.readRootSchema(resolved, moduleName);
  } catch (e) {
    problems.push(problem('readRootSchema', moduleName, e.message,
      'schema.json must be valid JSON when present.'));
  }

  // A refused layout has no handlers/ to resolve; the layout problem says so.
  if (layout != null) {
    return validator.validateDeviceSpec(spec, (specErr) => {
      if (specErr != null) specProblems(specErr, moduleName).forEach((p) => problems.push(p));
      return callback(null, {ok: false, module: moduleName, problems: problems, warnings: warnings});
    });
  }

  let resolvedMap = null;
  let threw = false;
  try {
    resolvedMap = handlerMapModule.resolveHandlerMap(resolved, requireModuleFile);
  } catch (e) {
    threw = true;
    problems.push(problem('resolveHandlerMap', moduleName,
      `handler map could not be loaded: ${e.message}`,
      'A handler file threw while being required.'));
  }

  if (resolvedMap == null && !threw) {
    problems.push(problem('resolveHandlerMap', moduleName,
      `${moduleName}: no handler map found -- no handlers/ directory.`,
      'A module is api.json, schema.json and handlers/<service>/<action>.js. ' +
      'See docs/module-development.md.'));
  } else if (resolvedMap != null) {
    handlerMapLib.validateHandlerMap(spec, resolvedMap.handlerMap, moduleName)
      .forEach((message) => {
        problems.push(problem('assembleHandlerMap', moduleName, message, null));
      });
  }

  return validator.validateDeviceSpec(spec, (specErr) => {
    if (specErr != null) specProblems(specErr, moduleName).forEach((p) => problems.push(p));
    return callback(null, {ok: problems.length === 0, module: moduleName, problems: problems, warnings: warnings});
  });
}

module.exports = {
  validateModule: validateModule
};
