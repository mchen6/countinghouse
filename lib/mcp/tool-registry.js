// Derives the MCP tools/list surface from the currently loaded device modules'
// specs (api.json + schema.json), with no persistent server-side state: every
// tool name is a deterministic function of device state, so tools/list and
// tools/call always agree on the same {name -> deviceID/serviceID/actionName}
// mapping without sharing anything between requests. This is what lets the
// gateway stay a stateless Streamable HTTP transport (2026-07-28 spec).
var async    = require('async');
var userAuth = require('../user-auth');
var LOG      = require('../logger');

function slugify(s) {
  var out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return out === '' ? 'x' : out;
}

function serviceLabel(urn) {
  var parts = String(urn).split(':');
  return slugify(parts[parts.length - 1]);
}

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

// async, for tools/list: targets + both schemas, MCP tool shape.
function buildToolList(cdifInterface, appKey, callback) {
  var targets = buildToolTargets(cdifInterface);
  var names   = Object.keys(targets);

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
  }, callback);
}

module.exports = {
  buildToolTargets: buildToolTargets,
  buildToolList:    buildToolList,
  slugify:          slugify
};
