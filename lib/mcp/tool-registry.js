'use strict';
// declared text as it leaves for the client (M18)
const clientText = require('../client-text');
// Derives the MCP tools/list surface from the currently loaded device modules'
// specs (api.json + schema.json), with no per-request or per-session state:
// every tool name is a deterministic function of device state, so tools/list
// and tools/call always agree on the same {name -> deviceID/serviceID/
// actionName} mapping. What is kept is only a cache of that function (the
// tool table, and a tools/call's output schemas), global and dropped on a
// tool-set change: the gateway stays a stateless Streamable HTTP transport
// (2026-07-28 spec).
const async    = require('async');
const options  = require('../cli-options');
const userAuth = require('../user-auth');
const getAuthProvider = require('../auth').getAuthProvider;
const LOG      = require('../logger');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;

// Extracted to tool-name.js: that module has no requires, so anything that
// needs to predict a tool name (lib/plan-validator.js) can pull in just this
// pure function without also pulling in this file's require()-time Redis
// socket and timer. Re-exported below so every existing caller is unaffected.
const slugify = require('./tool-name').slugify;
const serviceLabel = require('./tool-name').serviceLabel;
const roleOf = require('../module-roles').roleOf;
// the modules going on or off, listed to no one (main thread only); loaded once, never on a call's path
const visibility = require('../module-visibility');
const toolNameFor = require('./tool-name').toolNameFor;

// Platform-level tools -- not derived from any device module's spec, so
// they're not part of buildToolTargets' output and tools/call
// (lib/mcp/gateway.js) special-cases them by name before falling back to
// the device-tool lookup. Reserved here (not just in gateway.js) so
// buildToolTargets' name-dedup logic below never assigns a device tool the
// same name.
const PLATFORM_TOOL_NAMES = {
  'countinghouse_check_balance': true,
  'countinghouse_usage_report': true,
  'countinghouse_settings': true
};

const PLATFORM_TOOLS = [
  {
    name: 'countinghouse_check_balance',
    description: 'Check the calling API key\'s current metering balance on this countinghouse instance.',
    inputSchema:  {type: 'object', properties: {}},
    // No apiKey: tool output reaches model context and logs (spec 2026-11-06).
    outputSchema: {type: 'object', properties: {userName: {type: ['string', 'null']}, balance: {type: ['number', 'null']}},
      required: ['userName', 'balance'], additionalProperties: false}
  },
  // The usage report (local-mode spec §5): listed to every key in every mode,
  // the single-identity profile included; scoped to the caller's own calls
  // unless the caller is an admin (lib/usage/report.js).
  {
    name: 'countinghouse_usage_report',
    description: 'What this countinghouse has done for you: per tool, server, pack or module, the calls, the server calls made for them, and the lines and bytes read from servers and returned to the model, from this process and earlier ones. On a shared runtime, the calls of this session only. Token columns are an estimate (utf8 bytes / 4).',
    inputSchema:  require('../usage/report').INPUT_SCHEMA,
    outputSchema: require('../usage/report').OUTPUT_SCHEMA
  },
  // The settings tool (packs in place, part 2; spec #168 section 3): only in
  // the single-identity profile, and only with --settingsFile (platformTools).
  {
    name: 'countinghouse_settings',
    description: 'Read or change this countinghouse\'s settings within their bounds: get lists each setting, its bounds and the last 50 changes; set changes one. It can tighten a guarding setting (a smaller output cap, a shorter timeout, a pack turned off) but never loosen one: the user does that with the ch-local command. '
      + 'A loaded module\'s own settings are listed too, as module.<package>.<setting> (64 a call; pass nextCursor back as cursor for more): '
      + 'an enum, number or true/false one changes on request; text, and any the module marks, needs the user\'s own confirmation. Ask the user before changing one.',
    inputSchema:  require('../settings-tool').INPUT_SCHEMA
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
  'countinghouse_call_tool':       true,
  'countinghouse_reload_auth':     true,
  'countinghouse_lookup_identity': true
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
                 'just the first, each naming the stage and the way out. The module\'s code runs, ' +
                 'sandboxed, to resolve the handler map; the result describes the module and is not ' +
                 'a security check a hostile module cannot fool.',
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
    }
    // No outputSchema: the result is whatever the inner tool returns,
    // text-only for a tool without one.
  },
  {
    name: 'countinghouse_reload_auth',
    description: 'Re-read the auth configuration without a restart, the same as POST /reload-auth. ' +
                 'Grants added or removed apply from the next call. A configuration that fails its checks ' +
                 'is refused and the one in use stays. Admin only.',
    inputSchema: {type: 'object', properties: {}},
    outputSchema: {
      type: 'object',
      properties: {
        ok:      {type: 'boolean'},
        entries: {type: ['integer', 'null'], description: 'Entries now configured, when the provider counts them.'},
        changed: {type: 'integer', description: 'Entries added, removed or modified.'},
        note:    {type: 'string'}
      },
      required: ['ok', 'changed']
    }
  },
  {
    name: 'countinghouse_lookup_identity',
    description: 'The user behind an opaque caller id this server issued (ctx.caller.id, a bill\'s billedTo), ' +
                 'the same as POST /identity-lookup: {id, userName, isAdmin}, never the key. Admin only.',
    inputSchema: {type: 'object', properties: {id: {type: 'string', description: 'The id, u_ and 22 characters.'}}, required: ['id']},
    outputSchema: {
      type: 'object',
      properties: {id: {type: 'string'}, userName: {type: ['string', 'null'], description: 'null for an entry without a user name.'}, isAdmin: {type: 'boolean'}},
      required: ['id', 'userName', 'isAdmin']
    }
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

// Listed or not (local-mode spec §3, §4): a part a scenario pulled in is not
// listed (the module manager's `unlisted`, by package name), and in the
// single-identity profile only scenarios are. Unknown package info: listed, as
// every module was before roles.
// The actions a device's prompts and resources name as completion actions
// ("<service short name>.<action>", M11): never listed as tools
const shortServiceName = (serviceID) => { const i = String(serviceID).indexOf(':serviceID:'); return i === -1 ? String(serviceID) : String(serviceID).slice(i + ':serviceID:'.length); };
function completionActionsOf(spec) {
  const out = new Set();
  const named = (c) => {
    if (c == null || typeof(c) !== 'object' || Array.isArray(c)) return;
    for (const k of Object.keys(c)) if (typeof(c[k]) === 'string') out.add(c[k]);
  };
  const device = (spec != null && spec.device != null) ? spec.device : {};
  if (Array.isArray(device.promptList)) for (const p of device.promptList) if (p != null) named(p.completion);
  const services = (device.serviceList != null && typeof(device.serviceList) === 'object') ? device.serviceList : {};
  for (const id of Object.keys(services)) {
    const actions = (services[id] != null && Array.isArray(services[id].actionList)) ? services[id].actionList : [];
    for (const a of actions) if (a != null && a.resource != null && typeof(a.resource) === 'object') named(a.resource.completion);
  }
  return out;
}

// A device out of the device map is still its module's (F3-5): one whose
// worker exited (restarting or suspended: its spec is kept by the supervisor
// and still listed, DeviceManager getAllDeviceSpecs), one coming back after
// a restart or a reload, or one unloaded. It is listed, and a call to it
// refused or not, by its module's package.json, as while it ran; without
// that, an unlisted part's tools, prompts and resources were listed for as
// long as it was down, and a part could crash itself to get there. Its
// module and its package.json: DeviceManager moduleOfDevice (the visibility
// set reads the same) and packageOfModule, so a part is unlisted by name
// whatever the window. A device no module ever registered has no spec to
// list, and goes on to the call's own answer (DEVICE_NOT_FOUND), as before.
function listingOf(cdifInterface, deviceID) {
  const dm = cdifInterface.deviceManager;
  const device = dm.deviceMap != null ? dm.deviceMap[deviceID] : null;
  const mm = dm.moduleManager;
  let pkg = device != null ? device.packageInfo : null;
  if (device == null && typeof(dm.moduleOfDevice) === 'function' && typeof(dm.packageOfModule) === 'function') {
    const owner = dm.moduleOfDevice(deviceID);
    if (typeof(owner) === 'string') pkg = dm.packageOfModule(owner);
  }
  const role = roleOf(pkg);
  const unlisted = mm != null && mm.unlisted instanceof Set ? mm.unlisted : null;
  const pulledIn = pkg != null && unlisted != null && unlisted.has(pkg.name);
  return {role, listed: !pulledIn && (options.singleIdentity !== true || role === 'scenario')};
}

// synchronous, cheap: no schema resolution, just the name -> target mapping.
// action.description is mandatory for MCP exposure -- actions without one are
// skipped (logged, not fatal, so one under-documented module can't break
// tools/list for every other loaded module). A scenario's action is listed
// under its bare name (ci_failure_triage), every other module's under
// <device>_<service>_<action> (reviewer, 2026-11-11). {includeUnlisted: true}
// adds the modules that are not listed, after the listed ones and marked
// unlisted, so a tools/call can tell "not listed" from "unknown".
//
// Built once per change of its inputs (the latency breakdown, 2026-11-15,
// F3): every call used to rebuild the whole table to find one tool, which
// grows with every installed module. The table is kept per device manager
// and per includeUnlisted, with what it was built from -- each device's ID
// and spec object, and its listing (role, listed), and singleIdentity -- and
// handed out again while all of that is the same, in the same tool-set
// generation (lib/tool-generation.js). A reload or a worker's announcement
// replaces a spec object; a change made in place (CHDevice.updateDeviceSpec,
// in single-thread mode) bumps the generation, as does every toolsetChanged.
// The comparison walks the devices (cheap: no per-action work, which is what
// grew with installed tools). The table and its targets are frozen: callers
// share it.
//
// It holds only global state: what every caller would build. Anything that
// depends on the caller -- a key's devices (filterTargetsByAuth), the
// modules going on or off (filterTargetsBySession) -- must be applied AFTER it, on a copy, and never
// folded into it or its inputs (module-loading 30 holds this).
const toolGeneration = require('../tool-generation');
const hiddenVerdict = require('../hidden-text-verdict');
const declarations = require('../declarations');
const {advertisedSchema} = require('../binary-fields');
const builtTables = new WeakMap(); // deviceManager -> {false: built, true: built}

function sameInputs(a, b) {
  if (a.generation !== b.generation || a.single !== b.single || a.ids.length !== b.ids.length) return false;
  for (let i = 0; i < a.ids.length; i++) {
    if (a.ids[i] !== b.ids[i] || a.specs[i] !== b.specs[i] || a.listings[i] !== b.listings[i]) return false;
  }
  return true;
}

function buildToolTargets(cdifInterface, opts) {
  const includeUnlisted = opts != null && opts.includeUnlisted === true;
  const dm = cdifInterface.deviceManager;
  const specs   = dm.getAllDeviceSpecs();
  const ids = Object.keys(specs);
  const listings = {};
  for (const id of ids) listings[id] = listingOf(cdifInterface, id);
  const inputs = {generation: toolGeneration.current(), single: options.singleIdentity === true, ids, specs: ids.map((id) => specs[id]),
    listings: ids.map((id) => `${listings[id].role}\n${listings[id].listed}`)};
  const kept = builtTables.get(dm);
  const last = kept != null ? kept[includeUnlisted] : null;
  if (last != null && sameInputs(last.inputs, inputs)) return last.targets;

  const targets = {};
  const usedNames = {};
  for (const reserved in PLATFORM_TOOL_NAMES)  usedNames[reserved] = true;
  for (const reserved in AUTHORING_TOOL_NAMES) usedNames[reserved] = true;

  const order = ids.filter((id) => listings[id].listed).concat(includeUnlisted ? ids.filter((id) => !listings[id].listed) : []);
  // reserveOnly: the name is taken in the order, and no target made
  const add = (deviceID, spec, listing, serviceURN, action, unlisted, reserveOnly = false) => {
    const actionName = action.name;
    // (a description of hidden characters alone is none: M18)
    if (typeof(action.description) !== 'string' || clientText.line(action.description).trim() === '') {
      LOG.I(`MCP gateway: action ${serviceURN}/${actionName} on device ${
            deviceID  } has no description, skipping (description is mandatory for MCP tool exposure)`);
      return;
    }
    const name = dedupeName(usedNames, toolNameFor(listing.role, spec.device.friendlyName || deviceID, serviceURN, actionName));
    if (reserveOnly) return;
    targets[name] = {
      name:        name,
      deviceID:    deviceID,
      serviceID:   serviceURN,
      actionName:  actionName,
      description: action.description,
      action:      action
    };
    targets[name].role = listing.role;
    targets[name].module = spec.device.friendlyName || deviceID;
    if (unlisted) targets[name].unlisted = true;
    Object.freeze(targets[name]);
  };

  for (const deviceID of order) {
    const spec        = specs[deviceID];
    const serviceList = spec.device && spec.device.serviceList;
    if (serviceList == null) continue;
    const listing = listings[deviceID];
    const completing = completionActionsOf(spec);

    for (const serviceURN in serviceList) {
      const actionList = serviceList[serviceURN].actionList;
      if (actionList == null) continue;

      for (let i = 0; i < actionList.length; i++) {
        const action     = actionList[i];
        const actionName = action.name;

        // A resource action is not also a tool (MCP completeness M7, spec
        // section 3): resources are picked by the application and tools by
        // the model, and an action listed twice spends the model's context.
        // Its resource is read through resources/read (lib/mcp/resources.js);
        // ctx.call and invoke-action reach it as before.
        // Nor is a completion action (M11, spec section 7): it answers
        // completion/complete for a prompt or a resource of its module.
        // (the one rule, lib/declarations.js isTool: its kind here; one with
        // no description goes on to add(), which says so)
        if (!declarations.toolKind(action, `${shortServiceName(serviceURN)}.${actionName}`, completing)) continue;
        // One its declared text leaves unusable (F3-1): the load's one
        // decision (lib/hidden-text-verdict.js), so a tools/call, a task and
        // the HTTP routes refuse it as tools/list leaves it out (#400). Its
        // name keeps its place in the order (reserved, unlisted), so no
        // sibling takes it after a reload and a client calling the name it
        // had runs nothing else (the high review of #400).
        const hidden = hiddenVerdict.unusableAt(deviceID, serviceURN, actionName);
        add(deviceID, spec, listing, serviceURN, action, !listing.listed || hidden, hidden && !includeUnlisted);
      }
    }
  }
  Object.freeze(targets);
  const table = kept != null ? kept : {};
  table[includeUnlisted] = {inputs, targets};
  if (kept == null) builtTables.set(dm, table);
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
// The fallback itself is deliberate -- the tool stays listed rather than
// being dropped from tools/list, since dropping it would move the MCP surface:
// with DEFAULT_SCHEMA for an input, and with no outputSchema for an output
// (see resolveOutputSchema), so its results are sent as text. What changed is that it is no
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
// Note this is not deduplicated: schemas resolve per tools/list request, and a
// tools/call keeps only a schema that resolved (outputSchemaForCall), so a
// persistently broken pointer logs on every call. The file's only kept state
// is the tool table and the tools/call schemas, both global and dropped on
// a tool-set change (lib/tool-generation.js); a warned-already cache would
// be state of another kind (per pointer, never dropped), so there is none.
function logSchemaDowngrade(target, key, path, err) {
  const reason = (err != null)
    ? (err.message != null ? err.message : String(err))
    : 'the pointer resolved to no schema document';

  LOG.E(new CountinghouseError('TOOL_SCHEMA_RESOLVE_FAIL', target.name,
    `stage=resolveSchemas -- ${key} schema pointer "${path}" on device ${
    target.deviceID} did not resolve (${reason
    }); ${key === 'output'
      ? 'advertising no output schema instead, so its results are sent as text only'
      : 'advertising the permissive default schema instead, so calls to this tool may fail input validation'}`));
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

// The one place that decides a module tool's advertised output schema, used
// by tools/list and by every tools/call success path (gateway.js), so the two
// can never disagree about a tool. MCP requires structuredContent to conform
// to the advertised outputSchema. A tool gets one only when its action
// declares an output pointer that resolves, and then by era (forEra below):
// a modern request sees it whatever its root type, a legacy one only an
// object schema. Otherwise -- no pointer, or a pointer that fails to resolve
// (logged) -- the answer is null: listed without outputSchema, and called
// results are text only.
//
// Resolved per request, no cache: after a module reload or restart the next
// call sees the module's current schema.
//
// By era (MCP completeness M20, spec section 14): a modern request sees any
// output schema that resolves, whatever its root type; a legacy one only an
// object schema, as the earlier revisions required (a legacy SDK client may
// reject a non-object structuredContent). forEra is that one rule, for
// tools/list, tools/call and a task's stamp alike.
const forEra = (schema, modern) => (schema == null ? null : (modern === true || schema.type === 'object') ? schema : null);

function resolveOutputSchema(cdifInterface, appKey, target, callback, {modern = false} = {}) {
  return resolveOutputSchemaOrFailure(cdifInterface, appKey, target, downgradedOr(target, (err, schema) => callback(err, forEra(schema, modern))));
}

// resolveOutputSchemaOrFailure's callback for one answer: a failure is
// logged (logSchemaDowngrade) and answered as no schema, so the result goes
// as text; a schema is answered as it is, after onSchema(schema).
function downgradedOr(target, callback, onSchema = null) {
  return (failure, schema) => {
    if (failure != null) {
      logSchemaDowngrade(target, 'output', failure.path, failure.err);
      return callback(null, null);
    }
    if (onSchema != null) onSchema(schema);
    return callback(null, schema);
  };
}

// resolveOutputSchema's outcome with its failure told apart: callback(failure,
// schema), failure {path, err} when a declared pointer could not be resolved
// (which is not kept, lib below), else null and the schema (null for none).
function resolveOutputSchemaOrFailure(cdifInterface, appKey, target, callback) {
  const outputPath = schemaPathFor(target.action, 'output');
  if (outputPath == null) return callback(null, null);

  fetchSchema(cdifInterface, target.deviceID, appKey, outputPath, (err, data) => {
    if (err != null || data == null) return callback({path: outputPath, err}, null);
    // the schema itself, whatever its root type: forEra decides who sees it
    return callback(null, (data != null && typeof(data) === 'object' && !Array.isArray(data)) ? data : null);
  });
}

// A tools/call's output schema, resolved once per action object (the
// latency breakdown, F4): the call itself is authorized for this device
// before this runs (lib/mcp/gateway.js), and the schema is the module's
// own, the same for every caller. A reload replaces the spec and with it
// its action objects, and a change in place bumps the tool-set generation,
// so a kept schema is never a stale module's; a failed
// resolution is never kept. tools/list keeps resolveOutputSchema, per key.
const callSchemas = new WeakMap(); // target.action -> {schema, generation}

// resolve(cdifInterface, appKey, target, cb(failure, schema)): a test's
// stand-in for resolveOutputSchemaOrFailure. A failure is logged as
// resolveOutputSchema logs it, answered as no schema (the result goes as
// text), and resolved afresh on the next call.
// callback(null, the schema this era sees, the module's own schema): the
// module's own is kept (once per action and generation) and the era applied
// on each call (M20), so one entry serves both eras.
function outputSchemaForCall(cdifInterface, appKey, target, callback, resolve = resolveOutputSchemaOrFailure, {modern = false} = {}) {
  const generation = toolGeneration.current();
  const kept = target.action != null ? callSchemas.get(target.action) : null;
  if (kept != null && kept.generation === generation) return callback(null, forEra(kept.schema, modern), kept.schema);
  return resolve(cdifInterface, appKey, target, downgradedOr(target, (err, schema) => callback(err, forEra(schema, modern), schema), (schema) => {
    if (target.action != null && typeof(target.action) === 'object') callSchemas.set(target.action, {schema, generation});
  }));
}

// The listed tool target a job's action is, or null: how the usage
// counters know a task's tool name, role and module (step 3b).
function targetFor(cdifInterface, deviceID, serviceID, actionName) {
  const targets = buildToolTargets(cdifInterface);
  for (const name in targets) {
    const t = targets[name];
    if (t.deviceID === deviceID && t.serviceID === serviceID && t.actionName === actionName) return t;
  }
  return null;
}

// The same answer for a call that only knows where it was addressed (a task,
// read back by tasks/result). null when nothing loaded matches any more -- the
// module was unloaded or the action removed.
// raw: the module's own schema, unfiltered by era (forEra is then the
// caller's: a task's result builder and its stamp).
function resolveOutputSchemaFor(cdifInterface, appKey, deviceID, serviceID, actionName, callback, {raw = false} = {}) {
  const targets = buildToolTargets(cdifInterface);
  for (const name in targets) {
    const t = targets[name];
    if (t.deviceID === deviceID && t.serviceID === serviceID && t.actionName === actionName) {
      // a task's: the legacy era's (M20). A task is legacy-only until B's M15
      // adds the tasks extension; M15's task result and its schema hash must
      // then take the modern era's forEra.
      if (raw) return resolveOutputSchemaOrFailure(cdifInterface, appKey, t, downgradedOr(t, callback));
      return resolveOutputSchema(cdifInterface, appKey, t, callback);
    }
  }
  return callback(null, null);
}

function resolveSchemas(cdifInterface, appKey, target, callback, {modern = false} = {}) {
  const inputPath  = schemaPathFor(target.action, 'input');

  async.parallel({
    inputSchema: function(cb) {
      resolveOneSchema(cdifInterface, appKey, target, 'input', inputPath, cb);
    },
    outputSchema: function(cb) {
      resolveOutputSchema(cdifInterface, appKey, target, cb, {modern});
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
  grantedDevices(appKey, (err, granted) => {
    if (err) return callback(err);
    if (granted == null) return callback(null, targets);
    const filtered = {};
    for (const name in targets) {
      if (granted.has(targets[name].deviceID)) filtered[name] = targets[name];
    }
    return callback(null, filtered);
  });
}

// The devices `appKey` may reach, as tools/list filters them: callback(err,
// null) for every device (--debug, or a '*' grant), else a Set of device IDs
// (empty for no identity). Prompts are filtered by the same (M10).
function grantedDevices(appKey, callback) {
  if (options.debug === true) return callback(null, null);
  if (appKey == null) return callback(null, new Set()); // same as tools/call: no identity, no access
  getAuthProvider().listDevices(appKey, (err, result) => {
    // the provider's text to the log only (the medium on the ctx.error PR, 4)
    if (err) {
      try { require('../logger').E(err); } catch (logErr) { /* still answered */ }
      return callback(new CountinghouseError('SYSTEM_ERROR_USERDB_NA'));
    }
    const authorized = (result != null && Array.isArray(result.devices)) ? result.devices : [];
    if (authorized.indexOf('*') !== -1) return callback(null, null);
    return callback(null, new Set(authorized));
  });
}

// The built-ins tools/list shows: in the single-identity profile not the
// balance check, since no balance exists there (local-mode spec §4).
function platformTools() {
  if (options.singleIdentity !== true) return PLATFORM_TOOLS.filter((t) => t.name !== 'countinghouse_settings');
  return PLATFORM_TOOLS.filter((t) => t.name !== 'countinghouse_check_balance' && (t.name !== 'countinghouse_settings' || options.settingsFile != null));
}

// What every session lists of the tool table (#413 rev 3, section 5.5; M5a:
// no session has a view of its own): the same object while no module is
// going on or off (visibility.none(): one boolean), else a new one without
// the targets whose module is hidden, for everyone. Applied after
// buildToolTargets, on a copy. (The session argument is kept by the
// callers' shape; it decides nothing.)
// whether one target is listed: one boolean outside a load or an unload
// (tools/call's lookup, no allocation)
// NOTE: the view is global (M5a): sessionId is ignored; never rely on it to isolate one session from another (removed in M6)
const sessionLists = (sessionId, target) => visibility.none() || visibility.listsDevice(target.deviceID);
// NOTE: the view is global (M5a): sessionId is ignored; never rely on it to isolate one session from another (removed in M6)
function filterTargetsBySession(targets, sessionId) {
  if (visibility.none()) return targets;
  const out = {};
  for (const name of Object.keys(targets)) {
    if (visibility.listsDevice(targets[name].deviceID)) out[name] = targets[name];
  }
  return out;
}

// The caller's whole tools/list before any schema, in order (MCP
// completeness M1, spec section 5): the platform tools, then each listed
// device's actions the caller is granted (filtered by auth), in spec order.
// Each entry is {name, tool} for a built-in, already in MCP shape, or {name,
// target} for a module's action, whose schemas toolsFor resolves. Cheap: a
// page is cut from these, and only its own entries are resolved.
// session: kept by the callers' shape; it decides nothing (M5a: no session
// has a view of its own, and a module going on or off is listed to no one)
// NOTE: the view is global (M5a): `session` is ignored; never rely on it to isolate one session from another (removed in M6)
function listEntries(cdifInterface, appKey, callback, {session = null} = {}) {
  filterTargetsByAuth(appKey, filterTargetsBySession(buildToolTargets(cdifInterface), session), (err, targets) => {
    if (err) return callback(err);
    return callback(null, platformTools().map((tool) => ({name: tool.name, tool}))
      .concat(Object.keys(targets).map((name) => ({name, target: targets[name]}))));
  });
}

// listEntries' entries (all, or a page's) -> their MCP tools, in order, both
// schemas resolved for these entries only
// The schemas as they leave (F3-1, lib/client-text.js schema): text cleaned,
// annotations left out. Whether a tool is listed and callable at all is the
// load's one decision (lib/hidden-text-verdict.js, from the same walk in
// lib/declarations.js), which buildToolTargets has already applied for every
// route (#400); unlisted here is the schema-as-resolved view of it, for an
// era's tools/list only: a schema the load saw usable that resolves unusable
// now has nothing to advertise. schemas: as resolveSchemas gives them with
// {modern: true} (the output unfiltered).
function hiddenTextDecision(schemas) {
  const input = clientText.schema(schemas.inputSchema);
  const output = schemas.outputSchema != null ? clientText.schema(advertisedSchema(schemas.outputSchema)) : null;
  return {unlisted: input.unusable || (output != null && output.unusable), input, output};
}
// the action the spec serving under a target's device holds at its address,
// read from the device map's own entry (never a whole spec map)
function servingAction(cdifInterface, target) {
  const spec = cdifInterface.deviceManager != null ? cdifInterface.deviceManager.specOf(target.deviceID) : null;
  const service = (spec != null && spec.device != null && spec.device.serviceList != null && Object.hasOwn(spec.device.serviceList, target.serviceID)) ? spec.device.serviceList[target.serviceID] : null;
  const actions = (service != null && Array.isArray(service.actionList)) ? service.actionList : [];
  return actions.find((a) => a != null && a.name === target.actionName) || null;
}

function toolsFor(cdifInterface, appKey, entries, callback, {modern = false} = {}) {
  async.mapLimit(entries, 4, (entry, cb) => {
    if (entry.target == null) return cb(null, entry.tool);
    const target = entry.target;
    // (the decision and the tool set as this walk began: a reload, a new
    // decision or a spec changed in place meanwhile, and it marks nothing)
    const walkedAt = toolGeneration.current();
    const decision = hiddenVerdict.tokenOf(target.deviceID);
    resolveSchemas(cdifInterface, appKey, target, (err, schemas) => {
      if (err) return cb(err);
      // the declared description as it leaves, cleaned (M18, lib/client-text.js)
      // and its schemas' text (register follow-up (3), F3-1)
      const decided = hiddenTextDecision(schemas);
      // (unusable as resolved where the load saw it usable: recorded, so
      // every route refuses it as this list leaves it out, #400)
      if (decided.unlisted) {
        // (only while the action walked is still the one the serving spec
        // holds, and its decision and the tool set are those the walk began
        // on: a reload, a new decision or an in-place change meanwhile, and
        // it marks nothing)
        if (toolGeneration.current() === walkedAt && servingAction(cdifInterface, target) === target.action) {
          hiddenVerdict.markAt(target.deviceID, target.serviceID, target.actionName, decision);
        }
        return cb(null, null);
      }
      const tool = {
        name:        target.name,
        description: typeof(target.description) === 'string' ? clientText.message(target.description) : target.description,
        inputSchema: decided.input.schema
      };
      // as advertised: binary fields as their reference (M4,
      // lib/binary-fields.js), and only the one this era sees (forEra)
      if (forEra(schemas.outputSchema, modern) != null) tool.outputSchema = decided.output.schema;
      withMetadata(tool, target.action, keptIcons(cdifInterface, target.deviceID));
      cb(null, tool);
    }, {modern: true});
  }, (err, tools) => (err ? callback(err) : callback(null, tools.filter((t) => t != null))));
}

// MCP completeness M2 (spec section 4): what an action declares of title,
// annotations and icons, each only when declared, and after the keys a tool
// always had, so no existing tool's bytes move. The meta-schema bounds them
// (M0); the hints are the author's claims, and nothing here enforces them.
// An icon is inlined from what the load read and checked (keptIcons): a
// data: URI, never a URL, and never a file read now.
const ANNOTATION_HINTS = new Set(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);
function withMetadata(tool, action, kept) {
  if (action == null) return;
  if (typeof(action.title) === 'string') tool.title = clientText.line(action.title);
  if (action.annotations != null && typeof(action.annotations) === 'object' && !Array.isArray(action.annotations)) {
    const hints = {};
    for (const k of Object.keys(action.annotations)) if (ANNOTATION_HINTS.has(k) && typeof(action.annotations[k]) === 'boolean') hints[k] = action.annotations[k];
    // only when a hint is declared: an empty object says nothing
    if (Object.keys(hints).length > 0) tool.annotations = hints;
  }
  const icons = inlineIcons(action.icons, kept);
  if (icons != null) tool.icons = icons;
}

// A declaration's icons ([{file, sizes?}]) as MCP sends them, from what the
// load kept: [{src, mimeType, sizes?}], or null for none. A tool's, and a
// prompt's (M10).
// Each has beside it (lib/mcp/icon-digest.js, never on the object) the
// SHA-256 of its data, taken once per kept icon: what the listen hub's
// fingerprint reads in place of the data (F3-2, lib/mcp/subscriptions.js).
const iconDigests = require('./icon-digest');
const keptDigests = new WeakMap();
function digestOfKept(k, src) {
  let d = keptDigests.get(k);
  if (d == null) {
    d = `sha256:${require('crypto').createHash('sha256').update(src, 'utf8').digest('base64')}`;
    keptDigests.set(k, d);
  }
  return d;
}
function inlineIcons(declared, kept) {
  if (!Array.isArray(declared) || kept == null) return null;
  const out = [];
  for (const icon of declared) {
    const k = (icon != null && typeof(icon.file) === 'string') ? kept.get(icon.file) : null;
    if (k == null) continue;
    const entry = {src: k.src != null ? k.src : `data:${k.mimeType};base64,${k.data}`, mimeType: k.mimeType};
    iconDigests.set(entry, digestOfKept(k, entry.src));
    if (Array.isArray(icon.sizes)) entry.sizes = icon.sizes.filter((x) => typeof(x) === 'string');
    out.push(entry);
  }
  return out.length > 0 ? out : null;
}

// The icons the load kept for a device's module (lib/declared-icons.js
// inline): a worker's on its spec record, read at its spawn; single-thread
// mode's on the module instance, read at its instantiation. null for none.
function keptIcons(cdifInterface, deviceID) {
  const dm = cdifInterface.deviceManager;
  const device = (dm != null && dm.deviceMap != null) ? dm.deviceMap[deviceID] : null;
  if (device == null) return null;
  if (device.moduleSpec != null && device.moduleSpec.icons instanceof Map) return device.moduleSpec.icons;
  if (device.module != null && device.module.declaredIcons instanceof Map) return device.module.declaredIcons;
  return null;
}

// Whether an action of a spec is one tools/list lists as a tool (its rule in
// buildToolTargets): no resource action, no completion action, and a
// description that is more than hidden characters. For the schema route,
// which answers only what tools/list advertises (#400).
// (completing: the spec's completion actions, completionActionsOf, when
// asked of many actions of one spec)
function isToolAction(spec, serviceURN, action, completing = completionActionsOf(spec)) {
  if (action == null || typeof(action) !== 'object' || typeof(action.name) !== 'string') return false;
  return declarations.isTool(action, `${shortServiceName(serviceURN)}.${action.name}`, completing);
}

module.exports = {
  targetFor,
  isToolAction,
  completionActionsOf,
  buildToolTargets:   buildToolTargets,
  listEntries:        listEntries,
  filterTargetsBySession: filterTargetsBySession,
  sessionLists:       sessionLists,
  toolsFor:           toolsFor,
  platformTools:      platformTools,
  listingOf:          listingOf,
  dedupeName:         dedupeName,
  grantedDevices:     grantedDevices,
  keptIcons:          keptIcons,
  inlineIcons:        inlineIcons,
  resolveOutputSchema:    resolveOutputSchema,
  forEra:                 forEra,
  outputSchemaForCall:    outputSchemaForCall,
  resolveOutputSchemaFor: resolveOutputSchemaFor,
  slugify:            slugify,
  PLATFORM_TOOL_NAMES: PLATFORM_TOOL_NAMES,
  AUTHORING_TOOLS:      AUTHORING_TOOLS,
  AUTHORING_TOOL_NAMES: AUTHORING_TOOL_NAMES
};
