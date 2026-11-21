'use strict';
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
const moduleSettings = require('./module-settings');
const moduleLayout      = require('./module-layout');

// A module's files, as countinghouse code must name them: inside a sandboxed
// validation worker (review R1-4) the module is /app, reached through the
// identity hook's module specifier; elsewhere (the CLI, the child process) the
// path itself.
// (taken at load, not on first use: a validation worker loads this file
// at boot, and nothing of the runtime's after its lockdown, #194's PR 1)
const identity = require('./fs-broker/identity');
const schemaSafetyLib = require('./schema-safety');
const declaredIcons = require('./declared-icons');
const specifierFor = (p) => identity.specifierFor(p);
// (a module's file: its parent the module's own anchor, never this runtime
// file; lib/fs-broker/identity.js loadModuleFile)
const requireModuleFile = (p) => identity.loadModuleFile(specifierFor(p));

const DECLARATIONS_FIX = 'Change the declaration in api.json, or the schema it points to in schema.json, as the message says; the load refuses the module until then.';

// code: the runtime's error code, where the load answers with one too
// (MODULE_LAYOUT_UNSUPPORTED), so a caller matches it without the text.
function problem(stage, moduleName, message, fix, code) {
  const p = {stage: stage, module: moduleName, message: message, fix: fix || null};
  if (code != null) p.code = code;
  return p;
}

function readJSON(file, isStatic = false) {
  return JSON.parse((isStatic ? moduleTreeCheck.readPlainFile(file, STATIC_MAX) : fs.readFileSync(file)).toString());
}
// (a JSON file the static validation reads: far past any real one)
const STATIC_MAX = 4 * 1024 * 1024;

// Static validation (the single-identity profile's own modules,
// B-own-runtime): no handler file is required -- each stands in as a
// function, so the map is checked against api.json by its files alone --
// and a file that fails to parse is named, never quoted (a parse error's
// message can carry the file's text).
const STATIC_HANDLER = function staticHandler() { /* never run */ };
const staticRequire = () => STATIC_HANDLER;
const readFailure = (e, isStatic) => (!isStatic ? e.message
  : (e instanceof SyntaxError ? 'it is not valid JSON' : `it cannot be read (${e != null && e.code != null ? e.code : 'error'})`));

// The module's package.json. No module code is required here: a module is
// api.json, schema.json and handlers/ (lib/module-layout.js), and a main
// entry is never run, by the validator or the runtime.
function readPackage(modulePath, isStatic = false) {
  try {
    const pkg = readJSON(identity.pathFor(modulePath).join(modulePath, 'package.json'), isStatic);
    return {pkg: pkg, name: pkg.name, pkgError: null};
  } catch (e) {
    return {pkg: null, name: null, pkgError: readFailure(e, isStatic)};
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

// opts.static: no handler file required (STATIC_HANDLER), parse failures
// named, not quoted
function validateModule(modulePath, callback, opts = {}) {
  const isStatic = opts != null && opts.static === true;
  // a module worker validates /app, POSIX on every OS (identity.pathFor; issue #40)
  const resolved = identity.pathFor(modulePath).resolve(modulePath);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return callback(new Error(`${resolved} is not a directory`));
  }

  const loaded     = readPackage(resolved, isStatic);
  const moduleName = loaded.name || path.basename(resolved);
  const problems   = [];
  const warnings   = [];
  // M3: each remote as the load keeps it ({declared, meaning}), set below
  let remotes      = [];

  if (loaded.pkgError != null) {
    problems.push(problem('readPackageJson', moduleName,
      `package.json could not be read: ${loaded.pkgError}`,
      'Every module needs a package.json with a name.'));
  }

  // One module format (lib/module-layout.js), the load's own rule and text.
  // (static: package.json as read plainly above, never read again here)
  const givenPkg = isStatic ? (loaded.pkg != null ? loaded.pkg : null) : undefined;
  const layout = moduleLayout.layoutRefusal(resolved, moduleName, givenPkg);
  if (layout != null) {
    problems.push(problem('layout', moduleName, layout.message,
      'Move each action into handlers/<service>/<action>.js and remove the main entry. ' +
      'See docs/module-development.md.', layout.code));
  } else if (moduleLayout.hasHandlers(resolved) && moduleLayout.mainEntry(resolved, givenPkg) != null) {
    // Not a problem: the module loads from handlers/. But whatever the main
    // entry does (a handler map it exports included) never happens.
    warnings.push(problem('layout', moduleName,
      `${moduleLayout.mainEntry(resolved, givenPkg)} is never run: the module loads from handlers/`,
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
  const remotesParsed = remoteDeclaration.parseRemotes(loaded.pkg, {debug: false, redisEndpoint: null});
  const remotesFix = (remotesParsed.problems.length > 0) ? remoteDeclaration.fixFormOf(loaded.pkg) : null;
  remotesParsed.problems.forEach((message) => {
    problems.push(problem('countinghouse.remotes', moduleName, message, remotesFix));
  });
  // M3 (#413 section 6.1): each remote as the load keeps it, and what it
  // means, whichever form the author wrote.
  remotes = remotesParsed.remotes.map((r) => ({declared: r.declared, meaning: remoteDeclaration.meaningOf(r)}));
  // Module settings (lib/module-settings.js; the module-level configuration
  // design, section 4.1): the load refuses the same declaration
  // (SETTINGS_DECLARATION_INVALID), and warns the same way.
  const settingsDeclared = moduleSettings.parseDeclaration(loaded.pkg);
  settingsDeclared.problems.forEach((p) => {
    problems.push(problem('countinghouse.settings', moduleName, `${p.at}: ${p.message}`, p.fix, 'SETTINGS_DECLARATION_INVALID'));
  });
  settingsDeclared.warnings.forEach((message) => {
    warnings.push(problem('countinghouse.settings', moduleName, message,
      'See "Module settings" in docs/module-development.md.'));
  });
  // each declared setting and how it may be changed in conversation, so an
  // author sees what a user will be asked
  const settings = settingsDeclared.settings == null ? [] : Object.keys(settingsDeclared.settings).map((name) => {
    const d = settingsDeclared.settings[name];
    return {name, type: d.type, rule: moduleSettings.confirmRule(d, {part: loaded.pkg != null && loaded.pkg.countinghouse != null && loaded.pkg.countinghouse.role === 'part'})};
  });
  const tree = moduleTreeCheck.checkTree(resolved, {plain: isStatic});
  tree.problems.forEach((message) => problems.push(problem('checkTree', moduleName, message, null)));
  tree.warnings.forEach((message) => warnings.push(problem('checkTree', moduleName, message, null)));
  // (a directory link loads under audit and off, never under enforce)
  tree.dirLinks.concat(tree.brokenLinks, tree.manifestLinks).forEach((rel) => warnings.push(problem('checkTree', moduleName, `a link at ${rel} -- refused under --moduleSandbox enforce (a directory link, a linked package.json or one that doesn't resolve); use a flat install, or audit or off`, null)));
  tree.outsideMains.forEach((rel) => warnings.push(problem('checkTree', moduleName, `${rel}'s "main" leads outside the module -- refused under --moduleSandbox enforce; keep "main" inside the module`, null)));
  (tree.duplicateKeys || []).forEach((at) => warnings.push(problem('checkTree', moduleName, `${at} is written twice -- refused under --moduleSandbox enforce; write it once`, null)));
  (tree.escapedKeys || []).forEach((at) => warnings.push(problem('checkTree', moduleName, `${at} is written with an escape -- refused under --moduleSandbox enforce; write it plainly`, null)));
  (tree.notUtf8 || []).forEach((rel) => warnings.push(problem('checkTree', moduleName, `${rel} is not valid UTF-8 -- refused under --moduleSandbox enforce`, null)));

  let spec = null;
  const apiPath = path.join(resolved, 'api.json');
  try {
    spec = readJSON(apiPath, isStatic);
  } catch (e) {
    problems.push(problem('readApiJson', moduleName,
      `${isStatic ? 'api.json' : apiPath} could not be read: ${readFailure(e, isStatic)}`,
      'api.json declares the device, its services and their actions.'));
    return callback(null, {ok: false, module: moduleName, problems: problems, warnings: warnings, settings: settings, remotes: remotes});
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

  // schema.json and what the module declares, in the load's own sequence
  // (lib/schema-safety.js checkSchema, which the load refuses by): the text
  // is read once, by the path a module's own files are read by, and each
  // step is reached only when the one before found nothing.
  //   - What would stall or exhaust the validators (over 1 MB, checked
  //     before the text is parsed; a pattern that can backtrack; too many
  //     nodes; a $ref to itself or to nowhere): in the load's own words, so
  //     an author does not first hear of it from an operator.
  //   - schema.json is optional, but present-and-malformed is not legal.
  //   - What the module declares for the MCP layer, where the meta-schema
  //     cannot say it (lib/declarations.js): every problem and every
  //     warning. The load refuses the module for the first problem.
  // Each is the load's MODULE_ASSEMBLY_FAIL, at the stage named.
  const schemaSafety = schemaSafetyLib;
  let checked = null;
  try {
    // (static: schema.json read plainly, or not at all)
    const schemaFile = path.join(resolved, 'schema.json');
    const text = !isStatic ? schemaSafety.schemaText(resolved)
      : (fs.existsSync(schemaFile) ? moduleTreeCheck.readPlainFile(schemaFile, STATIC_MAX).toString('utf8') : null);
    checked = schemaSafety.checkSchema(text, spec);
  } catch (e) {
    // there, and not readable: the load's own error says so, below
    checked = {problem: null, unread: true, doc: null, declared: null};
  }
  if (checked.problem != null) {
    problems.push(problem('schemaSafety', moduleName, schemaSafety.safetyText(checked.problem), schemaSafety.SAFETY_FIX, 'MODULE_ASSEMBLY_FAIL'));
  } else if (checked.unread) {
    // in the words the load says it in (its own reader's)
    let message = `${moduleName}: schema.json could not be read as JSON`;
    if (!isStatic) {
      try { handlerMapModule.readRootSchema(resolved, moduleName); } catch (e) { message = e.message; }
    }
    problems.push(problem('readRootSchema', moduleName, message, 'schema.json must be valid JSON when present.', 'MODULE_ASSEMBLY_FAIL'));
  } else {
    checked.declared.problems.forEach((p) => problems.push(problem('declarations', moduleName, p.message, DECLARATIONS_FIX, 'MODULE_ASSEMBLY_FAIL')));
    checked.declared.warnings.forEach((w) => warnings.push(problem('declarations', moduleName, w.message, DECLARATIONS_FIX)));
  }
  // The icon files it names (lib/declared-icons.js): there, of an allowed
  // type, within the size bound, inside the module.
  declaredIcons.problems(resolved, spec)
    .forEach((p) => problems.push(problem('declarations', moduleName, p.message, 'An icon is a PNG, JPEG or WebP file of at most 16 KiB inside the module, named by its path from the module\'s root.')));

  // A refused layout has no handlers/ to resolve; the layout problem says so.
  if (layout != null) {
    return validator.validateDeviceSpec(spec, (specErr) => {
      if (specErr != null) specProblems(specErr, moduleName).forEach((p) => problems.push(p));
      return callback(null, {ok: false, module: moduleName, problems: problems, warnings: warnings, settings: settings, remotes: remotes});
    });
  }

  let resolvedMap = null;
  let threw = false;
  try {
    resolvedMap = handlerMapModule.resolveHandlerMap(resolved, isStatic ? staticRequire : requireModuleFile);
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
    return callback(null, {ok: problems.length === 0, module: moduleName, problems: problems, warnings: warnings, settings: settings, remotes: remotes});
  });
}

module.exports = {
  validateModule: validateModule
};
