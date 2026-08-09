// Derives the MCP tools/list surface from the currently loaded device modules'
// specs (api.json + schema.json), with no persistent server-side state: every
// tool name is a deterministic function of device state, so tools/list and
// tools/call always agree on the same {name -> deviceID/serviceID/actionName}
// mapping without sharing anything between requests. This is what lets the
// gateway stay a stateless Streamable HTTP transport (2026-07-28 spec).
var async    = require('async');
var options  = require('../cli-options');
var userAuth = require('../user-auth');
var getAuthProvider = require('../auth').getAuthProvider;
var LOG      = require('../logger');

function slugify(s) {
  var out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return out === '' ? 'x' : out;
}

function serviceLabel(urn) {
  var parts = String(urn).split(':');
  return slugify(parts[parts.length - 1]);
}

// Platform-level tools -- not derived from any device module's spec, so
// they're not part of buildToolTargets' output and tools/call
// (lib/mcp/gateway.js) special-cases them by name before falling back to
// the device-tool lookup. Reserved here (not just in gateway.js) so
// buildToolTargets' name-dedup logic below never assigns a device tool the
// same name.
var PLATFORM_TOOL_NAMES = {
  'countinghouse_check_balance': true
};

var PLATFORM_TOOLS = [
  {
    name: 'countinghouse_check_balance',
    description: 'Check the calling API key\'s current metering balance on this countinghouse instance.',
    inputSchema:  {type: 'object', properties: {}},
    outputSchema: {type: 'object', properties: {apiKey: {type: 'string'}, balance: {type: ['number', 'null']}}}
  }
];

function dedupeName(usedNames, name) {
  if (usedNames[name] == null) {
    usedNames[name] = true;
    return name;
  }
  var n = 2;
  while (usedNames[name + '_' + n] != null) n++;
  usedNames[name + '_' + n] = true;
  return name + '_' + n;
}

// synchronous, cheap: no schema resolution, just the name -> target mapping.
// action.description is mandatory for MCP exposure -- actions without one are
// skipped (logged, not fatal, so one under-documented module can't break
// tools/list for every other loaded module).
function buildToolTargets(cdifInterface) {
  var specs   = cdifInterface.deviceManager.getAllDeviceSpecs();
  var targets = {};
  var usedNames = {};
  for (var reserved in PLATFORM_TOOL_NAMES) usedNames[reserved] = true;

  for (var deviceID in specs) {
    var spec        = specs[deviceID];
    var serviceList = spec.device && spec.device.serviceList;
    if (serviceList == null) continue;

    var deviceSlug = slugify(spec.device.friendlyName || deviceID);

    for (var serviceURN in serviceList) {
      var service    = serviceList[serviceURN];
      var actionList = service.actionList;
      if (actionList == null) continue;

      var svcLabel = serviceLabel(serviceURN);

      for (var actionName in actionList) {
        var action = actionList[actionName];

        if (typeof(action.description) !== 'string' || action.description.trim() === '') {
          LOG.I('MCP gateway: action ' + serviceURN + '/' + actionName + ' on device ' +
                deviceID + ' has no description, skipping (description is mandatory for MCP tool exposure)');
          continue;
        }

        var name = dedupeName(usedNames, deviceSlug + '_' + svcLabel + '_' + slugify(actionName));

        targets[name] = {
          name:        name,
          deviceID:    deviceID,
          serviceID:   serviceURN,
          actionName:  actionName,
          description: action.description,
          service:     service,
          action:      action
        };
      }
    }
  }
  return targets;
}

function schemaPathFor(service, relatedStateVariable) {
  if (relatedStateVariable == null || service.serviceStateTable == null) return null;
  var stateVar = service.serviceStateTable[relatedStateVariable];
  if (stateVar == null || typeof(stateVar.schema) !== 'string') return null;
  return stateVar.schema;
}

// fetches one dereferenced schema subtree for a device via the same
// getDeviceSchema round trip the /devices/:id/schema route uses -- this is
// what makes schema resolution work transparently whether the device lives
// in the main thread or inside a worker (worker-thread mode proxies this
// through a message round trip; there's no way to reach a worker's live
// schemaDoc synchronously from here).
function fetchSchema(cdifInterface, deviceID, appKey, path, callback) {
  userAuth(null, null, deviceID, appKey, null, null, function(err, data) {
    return callback(err, data);
  }, function(err, session) {
    if (err) return callback(err);
    cdifInterface.getDeviceSchema(deviceID, path, null, session);
  });
}

var DEFAULT_SCHEMA = {type: 'object', properties: {}};

function resolveSchemas(cdifInterface, appKey, target, callback) {
  var inputVar  = target.action.argumentList && target.action.argumentList.input  && target.action.argumentList.input.relatedStateVariable;
  var outputVar = target.action.argumentList && target.action.argumentList.output && target.action.argumentList.output.relatedStateVariable;

  var inputPath  = schemaPathFor(target.service, inputVar);
  var outputPath = schemaPathFor(target.service, outputVar);

  async.parallel({
    inputSchema: function(cb) {
      if (inputPath == null) return cb(null, DEFAULT_SCHEMA);
      fetchSchema(cdifInterface, target.deviceID, appKey, inputPath, function(err, data) {
        if (err || data == null) return cb(null, DEFAULT_SCHEMA);
        cb(null, data);
      });
    },
    outputSchema: function(cb) {
      if (outputPath == null) return cb(null, DEFAULT_SCHEMA);
      fetchSchema(cdifInterface, target.deviceID, appKey, outputPath, function(err, data) {
        if (err || data == null) return cb(null, DEFAULT_SCHEMA);
        cb(null, data);
      });
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

  getAuthProvider().listDevices(appKey, function(err, result) {
    if (err) return callback(err);

    var authorizedDeviceIDs = (result != null && Array.isArray(result.devices)) ? result.devices : [];
    if (authorizedDeviceIDs.indexOf('*') !== -1) return callback(null, targets);

    var filtered = {};
    for (var name in targets) {
      if (authorizedDeviceIDs.indexOf(targets[name].deviceID) !== -1) filtered[name] = targets[name];
    }
    return callback(null, filtered);
  });
}

// async, for tools/list: device targets (filtered by auth) + both schemas,
// plus the static platform tools, all in MCP tool shape.
function buildToolList(cdifInterface, appKey, callback) {
  var allTargets = buildToolTargets(cdifInterface);

  filterTargetsByAuth(appKey, allTargets, function(err, targets) {
    if (err) return callback(err);

    var names = Object.keys(targets);

    async.mapLimit(names, 4, function(name, cb) {
      var target = targets[name];
      resolveSchemas(cdifInterface, appKey, target, function(err, schemas) {
        if (err) return cb(err);
        cb(null, {
          name:         target.name,
          description:  target.description,
          inputSchema:  schemas.inputSchema,
          outputSchema: schemas.outputSchema
        });
      });
    }, function(err, deviceTools) {
      if (err) return callback(err);
      return callback(null, PLATFORM_TOOLS.concat(deviceTools));
    });
  });
}

module.exports = {
  buildToolTargets:   buildToolTargets,
  buildToolList:      buildToolList,
  slugify:            slugify,
  PLATFORM_TOOL_NAMES: PLATFORM_TOOL_NAMES
};
