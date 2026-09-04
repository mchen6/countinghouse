// Derives the MCP tools/list surface from the currently loaded device modules'
// specs (api.json + schema.json), with no persistent server-side state: every
// tool name is a deterministic function of device state, so tools/list and
// tools/call always agree on the same {name -> deviceID/serviceID/actionName}
// mapping without sharing anything between requests. This is what lets the
// gateway stay a stateless Streamable HTTP transport (2026-07-28 spec).
const async    = require('async');
const options  = require('../cli-options');
const userAuth = require('../user-auth');
const getAuthProvider = require('../auth').getAuthProvider;
const LOG      = require('../logger');
const CHError  = require('../countinghouse-error').CHError;

// Extracted to tool-name.js: that module has no requires, so anything that
// needs to predict a tool name (lib/plan-validator.js) can pull in just this
// pure function without also pulling in this file's require()-time Redis
// socket and timer. Re-exported below so every existing caller is unaffected.
const slugify = require('./tool-name').slugify;

function serviceLabel(urn) {
  const parts = String(urn).split(':');
  return slugify(parts[parts.length - 1]);
}

// Platform-level tools -- not derived from any device module's spec, so
// they're not part of buildToolTargets' output and tools/call
// (lib/mcp/gateway.js) special-cases them by name before falling back to
// the device-tool lookup. Reserved here (not just in gateway.js) so
// buildToolTargets' name-dedup logic below never assigns a device tool the
// same name.
const PLATFORM_TOOL_NAMES = {
  'countinghouse_check_balance': true
};

const PLATFORM_TOOLS = [
  {
    name: 'countinghouse_check_balance',
    description: 'Check the calling API key\'s current metering balance on this countinghouse instance.',
    inputSchema:  {type: 'object', properties: {}},
    outputSchema: {type: 'object', properties: {apiKey: {type: 'string'}, balance: {type: ['number', 'null']}}}
  }
];

// Authoring tools: admin-gated AND off unless --authoringTools. Defined here
// so every platform tool definition lives in one file, but gated in
// gateway.js, which is where caller identity is resolved.
//
// Their names are reserved unconditionally (below), even when the flag is
// off: reserving costs nothing, and it means enabling the flag can never
// collide with a device tool that had already taken the name.
const AUTHORING_TOOL_NAMES = {
  'countinghouse_validate_plan':   true,
  'countinghouse_validate_module': true,
  'countinghouse_load_module':     true,
  'countinghouse_call_tool':       true
};

const PROBLEM_LIST_SCHEMA = {
  type: 'object',
  properties: {
    ok:      {type: 'boolean'},
    module:  {type: 'string'},
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stage:   {type: 'string'},
          module:  {type: 'string'},
          message: {type: 'string'},
          fix:     {type: ['string', 'null']}
        }
      }
    }
  }
};

const AUTHORING_TOOLS = [
  {
    name: 'countinghouse_validate_plan',
    description: 'Check a proposed module design -- device, services, actions -- before writing ' +
                 'any files. Reports naming problems, duplicates, missing descriptions and ' +
                 'collisions with tools already on this runtime, plus the tool names the plan would produce.',
    inputSchema: {
      type: 'object',
      properties: {
        device:   {type: 'string', description: 'Device friendlyName for the module.'},
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:    {type: 'string', description: 'Service short name, e.g. greetService.'},
              actions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name:        {type: 'string'},
                    description: {type: 'string'}
                  },
                  required: ['name', 'description']
                }
              }
            },
            required: ['name', 'actions']
          }
        },
        calls: {
          type: 'array',
          items: {type: 'string'},
          description: 'Composition addresses this module intends to call, in ' +
                       '<module>/<service>.<action> form -- the same shape as package.json\'s ' +
                       'countinghouse.calls. Optional.'
        }
      },
      required: ['device', 'services']
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok:        {type: 'boolean'},
        problems:  {type: 'array', items: {type: 'object'}},
        toolNames: {type: 'array', items: {type: 'string'}}
      }
    }
  },
  {
    name: 'countinghouse_validate_module',
    description: 'Validate a countinghouse module directory: api.json, schema.json and the ' +
                 'handler map checked against each other. Returns every problem found, not ' +
                 'just the first, each naming the stage and the way out.',
    inputSchema: {
      type: 'object',
      properties: {path: {type: 'string', description: 'Absolute path to the module directory.'}},
      required: ['path']
    },
    outputSchema: PROBLEM_LIST_SCHEMA
  },
  {
    name: 'countinghouse_load_module',
    description: 'Load a countinghouse module from a local path into this running runtime, ' +
                 'and report the MCP tool names it made callable. Admin only.',
    inputSchema: {
      type: 'object',
      properties: {
        path:    {type: 'string', description: 'Absolute path to the module directory.'},
        name:    {type: 'string', description: 'Module name to register it under.'},
        version: {type: 'string', description: 'Module version, e.g. 1.0.0.'}
      },
      required: ['path', 'name']
    },
    outputSchema: {
      type: 'object',
      properties: {
        loaded:            {type: 'boolean'},
        name:              {type: 'string'},
        version:           {type: ['string', 'null']},
        toolNames:         {type: 'array', items: {type: 'string'}},
        // False means the bounded post-load discovery wait ran out before
        // this module's device came online -- toolNames may be incomplete
        // (or empty) and the caller should not treat it as final. True
        // means the module's devices are confirmed present (whether that
        // took a moment to discover or was already true on a reload), so an
        // empty toolNames alongside true is a real fact -- this module
        // genuinely exposes nothing callable -- not a timeout.
        discoveryComplete: {type: 'boolean'}
      }
    }
  },
  {
    name: 'countinghouse_call_tool',
    description: 'Invoke a tool on this runtime by name. Exists so a just-loaded module can ' +
                 'be called without waiting for the MCP client to refresh its tool list.',
    inputSchema: {
      type: 'object',
      properties: {
        name:      {type: 'string', description: 'The MCP tool name to invoke.'},
        arguments: {type: 'object', description: 'Arguments for that tool.'}
      },
      required: ['name']
    },
    outputSchema: {type: 'object'}
  }
];

// AUTHORING_TOOL_NAMES is the reservation list and is deliberately NOT
// derived from AUTHORING_TOOLS: it must hold the names of tools Tasks 4/5
// haven't defined yet (see the reservation comment above). That means the
// two can drift the other way instead -- a tool added to AUTHORING_TOOLS
// whose name was never reserved would still be dispatchable (gateway.js
// gates on AUTHORING_TOOL_NAMES) but would list under a name nothing
// reserved, silently reopening the dedup collision this file exists to
// prevent. Fail at require() time instead of shipping that slip as a
// listable-but-uncallable (or unreserved) tool.
AUTHORING_TOOLS.forEach((tool) => {
  if (AUTHORING_TOOL_NAMES[tool.name] !== true) {
    throw new Error(`tool-registry.js: AUTHORING_TOOLS entry '${tool.name}' is not reserved in AUTHORING_TOOL_NAMES`);
  }
});

function dedupeName(usedNames, name) {
  if (usedNames[name] == null) {
    usedNames[name] = true;
    return name;
  }
  let n = 2;
  while (usedNames[`${name}_${n}`] != null) n++;
  usedNames[`${name}_${n}`] = true;
  return `${name}_${n}`;
}

// synchronous, cheap: no schema resolution, just the name -> target mapping.
// action.description is mandatory for MCP exposure -- actions without one are
// skipped (logged, not fatal, so one under-documented module can't break
// tools/list for every other loaded module).
function buildToolTargets(cdifInterface) {
  const specs   = cdifInterface.deviceManager.getAllDeviceSpecs();
  const targets = {};
  const usedNames = {};
  for (const reserved in PLATFORM_TOOL_NAMES)  usedNames[reserved] = true;
  for (const reserved in AUTHORING_TOOL_NAMES) usedNames[reserved] = true;

  for (const deviceID in specs) {
    const spec        = specs[deviceID];
    const serviceList = spec.device && spec.device.serviceList;
    if (serviceList == null) continue;

    const deviceSlug = slugify(spec.device.friendlyName || deviceID);

    for (const serviceURN in serviceList) {
      const actionList = serviceList[serviceURN].actionList;
      if (actionList == null) continue;

      const svcLabel = serviceLabel(serviceURN);

      for (let i = 0; i < actionList.length; i++) {
        const action     = actionList[i];
        const actionName = action.name;

        if (typeof(action.description) !== 'string' || action.description.trim() === '') {
          LOG.I(`MCP gateway: action ${serviceURN}/${actionName} on device ${
                deviceID  } has no description, skipping (description is mandatory for MCP tool exposure)`);
          continue;
        }

        const name = dedupeName(usedNames, `${deviceSlug}_${svcLabel}_${slugify(actionName)}`);

        targets[name] = {
          name:        name,
          deviceID:    deviceID,
          serviceID:   serviceURN,
          actionName:  actionName,
          description: action.description,
          action:      action
        };
      }
    }
  }
  return targets;
}

// An action declares its argument schemas as pointers into the module's
// schema.json ({schema: '/echoService/echo/input'}). Anything else -- no such
// key, or an already-resolved schema document rather than a pointer -- means
// there is nothing to fetch, and the caller falls back to DEFAULT_SCHEMA.
function schemaPathFor(action, key) {
  const schemaObj = action[key];
  if (schemaObj == null || typeof(schemaObj.schema) !== 'string') return null;
  return schemaObj.schema;
}

// fetches one dereferenced schema subtree for a device via the same
// getDeviceSchema round trip the /devices/:id/schema route uses -- this is
// what makes schema resolution work transparently whether the device lives
// in the main thread or inside a worker (worker-thread mode proxies this
// through a message round trip; there's no way to reach a worker's live
// schemaDoc synchronously from here).
function fetchSchema(cdifInterface, deviceID, appKey, path, callback) {
  userAuth(null, null, deviceID, appKey, null, null, (err, data) => {
    return callback(err, data);
  }, (err, session) => {
    if (err) return callback(err);
    cdifInterface.getDeviceSchema(deviceID, path, session);
  });
}

const DEFAULT_SCHEMA = {type: 'object', properties: {}};

// One declared-but-unresolvable schema pointer: log it, then fall back.
//
// The fallback itself is deliberate and unchanged -- the tool stays listed
// with DEFAULT_SCHEMA rather than being dropped from tools/list, since
// dropping it would move the MCP surface. What changed is that it is no
// longer *silent*: both branches of resolveSchemas used to be
// `if (err || data == null) return cb(null, DEFAULT_SCHEMA);`, which threw
// the error away. The result is a tool advertising {type: 'object',
// properties: {}} -- "any object is fine" -- so a caller sends what that
// permits and the call then fails server-side in validateActionCall, with
// nothing upstream to explain why.
//
// LOG.E, not the LOG.I that buildToolTargets uses for its "no description,
// skipping" case: that one omits the action, which is at least consistent,
// while this one ships a tool whose advertised contract is wrong. The
// stricter outcome gets the louder level.
//
// Three conditions are collapsed at the call sites and only two are faults.
// "No pointer declared at all" is legitimate and common, so it never reaches
// here -- the caller returns DEFAULT_SCHEMA without logging. This
// distinguishes the other two, because "the fetch failed" and "the fetch
// succeeded and produced nothing" have different causes and different fixes.
//
// Note this is not deduplicated: schemas resolve per tools/list request (this
// file keeps no state on purpose -- see the header), so a persistently broken
// pointer logs on every call. That matches what buildToolTargets already does
// for its own skip case, and adding a warned-already cache here would be the
// one piece of cross-request state in a module built to have none.
function logSchemaDowngrade(target, key, path, err) {
  const reason = (err != null)
    ? (err.message != null ? err.message : String(err))
    : 'the pointer resolved to no schema document';

  LOG.E(new CHError('TOOL_SCHEMA_RESOLVE_FAIL', target.name,
    `stage=resolveSchemas -- ${key} schema pointer "${path}" on device ${
    target.deviceID} did not resolve (${reason
    }); advertising the permissive default schema instead, so calls to this tool may fail input validation`));
}

function resolveOneSchema(cdifInterface, appKey, target, key, path, cb) {
  // no pointer declared -- nothing to resolve and nothing wrong
  if (path == null) return cb(null, DEFAULT_SCHEMA);

  fetchSchema(cdifInterface, target.deviceID, appKey, path, (err, data) => {
    if (err != null || data == null) {
      logSchemaDowngrade(target, key, path, err);
      return cb(null, DEFAULT_SCHEMA);
    }
    return cb(null, data);
  });
}

function resolveSchemas(cdifInterface, appKey, target, callback) {
  const inputPath  = schemaPathFor(target.action, 'input');
  const outputPath = schemaPathFor(target.action, 'output');

  async.parallel({
    inputSchema: function(cb) {
      resolveOneSchema(cdifInterface, appKey, target, 'input', inputPath, cb);
    },
    outputSchema: function(cb) {
      resolveOneSchema(cdifInterface, appKey, target, 'output', outputPath, cb);
    }
  }, callback);
}

// Filters `targets` (buildToolTargets' deviceID-derived tool map) down to
// only the devices `appKey` is authorized for, via the configured
// AuthProvider's listDevices (lib/auth/) -- so tools/list only ever
// advertises tools a subsequent tools/call from the same apiKey could
// actually invoke (previously it did not: every loaded device's tools were
// always listed, degrading only to a default/unresolved schema -- never
// omitted -- for a device the caller couldn't access). Under --debug mode,
// skipped entirely, matching every other userAuth-gated entry path's "no
// per-device enforcement" debug-mode model (lib/user-auth.js).
function filterTargetsByAuth(appKey, targets, callback) {
  if (options.debug === true) return callback(null, targets);
  if (appKey == null) return callback(null, {}); // same as tools/call: no identity, no access

  getAuthProvider().listDevices(appKey, (err, result) => {
    if (err) return callback(err);

    const authorizedDeviceIDs = (result != null && Array.isArray(result.devices)) ? result.devices : [];
    if (authorizedDeviceIDs.indexOf('*') !== -1) return callback(null, targets);

    const filtered = {};
    for (const name in targets) {
      if (authorizedDeviceIDs.indexOf(targets[name].deviceID) !== -1) filtered[name] = targets[name];
    }
    return callback(null, filtered);
  });
}

// async, for tools/list: device targets (filtered by auth) + both schemas,
// plus the static platform tools, all in MCP tool shape.
function buildToolList(cdifInterface, appKey, callback) {
  const allTargets = buildToolTargets(cdifInterface);

  filterTargetsByAuth(appKey, allTargets, (err, targets) => {
    if (err) return callback(err);

    const names = Object.keys(targets);

    async.mapLimit(names, 4, (name, cb) => {
      const target = targets[name];
      resolveSchemas(cdifInterface, appKey, target, (err, schemas) => {
        if (err) return cb(err);
        cb(null, {
          name:         target.name,
          description:  target.description,
          inputSchema:  schemas.inputSchema,
          outputSchema: schemas.outputSchema
        });
      });
    }, (err, deviceTools) => {
      if (err) return callback(err);
      return callback(null, PLATFORM_TOOLS.concat(deviceTools));
    });
  });
}

module.exports = {
  buildToolTargets:   buildToolTargets,
  buildToolList:      buildToolList,
  slugify:            slugify,
  PLATFORM_TOOL_NAMES: PLATFORM_TOOL_NAMES,
  AUTHORING_TOOLS:      AUTHORING_TOOLS,
  AUTHORING_TOOL_NAMES: AUTHORING_TOOL_NAMES
};
