#!/usr/bin/env node
//
// Converts a device module's api.json from the pre-5.0.0 spec format to the
// 5.0.0 one.
//
//   countinghouse-migrate-spec <module-dir-or-api.json> [...]
//   countinghouse-migrate-spec --stdout <api.json>      # print, don't write
//
// What changes:
//
//   before                                  after
//   ------------------------------------    ------------------------------------
//   actionList: {"echo": {...}}             actionList: [{"name": "echo", ...}]
//   argumentList.input.relatedStateVariable input: {schema: "/echoService/echo/input"}
//     -> serviceStateTable[v].schema
//   argumentList.output...                  output: {schema: "..."}
//   fault: {schema: "..."}                  unchanged
//   serviceStateTable                       (removed -- its schema pointers move
//                                            onto the action that used them)
//   configId, specVersion                   (removed -- nothing ever read them)
//   direction, relatedStateVariable, retval (removed -- the UPnP indirection)
//   realPrice, priceInfo, freeCount         (removed -- retired with AuthProvider)
//   apiCache, apiLog                        (removed -- see 5.0.0 release notes)
//
// The conversion is order-preserving: actions appear in the array in the same
// order their keys appeared in the object, so the MCP tools/list surface a
// module produces is unchanged. It is also idempotent -- a spec already in the
// new format is passed through untouched, so re-running this over a tree is
// safe.
var fs   = require('fs');
var path = require('path');

var DROPPED_ACTION_KEYS = ['argumentList', 'realPrice', 'priceInfo', 'freeCount', 'apiCache', 'apiLog'];

function isOldFormat(spec) {
  if (spec == null || spec.device == null || spec.device.serviceList == null) return false;
  var serviceList = spec.device.serviceList;
  for (var serviceID in serviceList) {
    if (serviceList[serviceID].serviceStateTable != null) return true;
    if (!Array.isArray(serviceList[serviceID].actionList)) return true;
  }
  return false;
}

// Resolves one old-style argument to the schema pointer it ultimately named:
// argumentList[key].relatedStateVariable -> serviceStateTable[var].schema.
function schemaPointerFor(stateTable, argument, where) {
  if (argument == null) return null;

  var varName = argument.relatedStateVariable;
  if (varName == null) {
    throw new Error(where + ': argument has no relatedStateVariable, nothing to convert it to');
  }

  var stateVar = stateTable && stateTable[varName];
  if (stateVar == null) {
    throw new Error(where + ': relatedStateVariable "' + varName + '" is not in serviceStateTable');
  }
  if (typeof(stateVar.schema) !== 'string') {
    throw new Error(where + ': state variable "' + varName + '" has no schema pointer (dataType ' +
                    stateVar.dataType + '). Only object arguments carry over to the 5.0.0 format.');
  }
  return stateVar.schema;
}

function migrateAction(actionName, action, stateTable, where) {
  var out = {name: actionName};

  if (action.description != null) out.description = action.description;

  var argumentList = action.argumentList || {};
  var inputPtr  = schemaPointerFor(stateTable, argumentList.input,  where + '/input');
  var outputPtr = schemaPointerFor(stateTable, argumentList.output, where + '/output');

  if (inputPtr  != null) out.input  = {schema: inputPtr};
  if (outputPtr != null) out.output = {schema: outputPtr};
  if (action.fault != null) out.fault = JSON.parse(JSON.stringify(action.fault));

  for (var key in action) {
    if (key === 'name' || key === 'description' || key === 'fault') continue;
    if (DROPPED_ACTION_KEYS.indexOf(key) !== -1) continue;
    // anything unrecognized is carried over rather than silently dropped; the
    // meta-schema will then reject it loudly instead of the data vanishing here
    out[key] = action[key];
  }
  return out;
}

function migrate(spec, label) {
  if (!isOldFormat(spec)) return spec;

  var out = JSON.parse(JSON.stringify(spec));
  delete out.configId;
  delete out.specVersion;

  var serviceList = out.device.serviceList;

  for (var serviceID in serviceList) {
    var service = serviceList[serviceID];
    if (Array.isArray(service.actionList)) continue; // already converted

    var stateTable = service.serviceStateTable;
    var actions    = [];

    for (var actionName in service.actionList) {
      actions.push(migrateAction(actionName, service.actionList[actionName], stateTable,
                                 label + ' ' + serviceID + '/' + actionName));
    }

    service.actionList = actions;
    delete service.serviceStateTable;
  }
  return out;
}

function apiJsonPathFor(target) {
  var stat = fs.statSync(target);
  return stat.isDirectory() ? path.join(target, 'api.json') : target;
}

function main(argv) {
  var toStdout = false;
  var targets  = [];

  argv.forEach(function(a) {
    if (a === '--stdout') toStdout = true;
    else targets.push(a);
  });

  if (targets.length === 0) {
    console.error('usage: countinghouse-migrate-spec [--stdout] <module-dir-or-api.json> [...]');
    return 2;
  }

  var failed = 0;

  targets.forEach(function(target) {
    var file = apiJsonPathFor(target);
    try {
      var spec = JSON.parse(fs.readFileSync(file, 'utf8'));

      if (!isOldFormat(spec)) {
        if (toStdout) process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
        else console.log(file + ': already in the 5.0.0 format, unchanged');
        return;
      }

      var out = migrate(spec, file);

      if (toStdout) {
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      } else {
        fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
        console.log(file + ': migrated to the 5.0.0 format');
      }
    } catch (e) {
      console.error(file + ': ' + e.message);
      failed++;
    }
  });

  return failed === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {migrate: migrate, isOldFormat: isOldFormat};
