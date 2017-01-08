var options               = require('../lib/cli-options');
var ajv                   = new require('ajv')();
var deviceRootSchema      = require('../spec/schema.json');
var deviceSchemaValidator = ajv.compile(deviceRootSchema);



module.exports = {
  getSchemaValidator: function() {
    return ajv;
  },

  validate: function(name, varDef, data, callback) {
    var type  = varDef.dataType;
    var range = varDef.allowedValueRange;
    var list  = varDef.allowedValueList;

    var errorMessage = null;

    if (type == null) {  //check null and undefined
      errorMessage = 'cannot identify variable data type';
    }
    if (data === null) {
      errorMessage = 'data must not be NULL';
    }
    if (errorMessage === null) {
      switch (type) {
        case 'number':
          if (typeof(data) !== 'number') {
            errorMessage = 'data is not a number';
          }
          break;
        case 'integer':
          if (typeof(data) !== 'number' || (data % 1) !== 0) {
            errorMessage = 'data is not an integer';
          }
          break;
        case 'string':
          if (typeof(data) !== 'string') {
            errorMessage = 'data is not a string';
          }
          break;
        case 'boolean':
          if (typeof(data) !== 'boolean') {
            errorMessage = 'data is not a boolean';
          }
          break;
        case 'object':
          if (typeof(data) !== 'object' && typeof(data) !== 'array') {
            errorMessage = 'data is not a object';
          } else {
            var schema = varDef.schema;
            if (schema == null) {   // check both null and undefined
              errorMessage = 'data has no schema';
            } else if (typeof(schema) !== 'object') {
              errorMessage = 'schema not resolved yet';
            } else {
              var validator = varDef.validator;
              if (validator == null) {
                errorMessage = 'schema validator is not available';
              } else {
                try {
                  if (!validator(data)) {
                    // errorMessage = name + ' ' + validator.errors[0].message;
                    errorMessage = name + validator.errors[0].dataPath;
                  }
                } catch (e) {
                  errorMessage = e.message;
                }
              }
            }
          }
          break;
        default:
          errorMessage = 'unknown data type: ' + type;
          break;
      }
    }
    if (errorMessage === null) {
      if (range) {
        if (data > range.maximum || data < range.minimum) {
          errorMessage = 'data exceeds allowed value range';
        }
      }
      if (list) {
        var matched = false;
        for (var i in list) {
          if (data === list[i]) matched = true;
        }
        if (matched === false) {
          errorMessage = 'cannot find matched value in allowed value list';
        }
      }
    }
    if (errorMessage) {
      // callback(new Error('data ' + name + ' validation failed, reason: ' + errorMessage));
      callback(new Error(errorMessage));
    } else {
      callback(null);
    }
  },

  validateDeviceSpec: function(spec, callback) {
    var errorMessage = null;

    try {
      if (!deviceSchemaValidator(spec)) {
        errorMessage = deviceSchemaValidator.errors[0].message;
      }
    } catch (e) {
      errorMessage = e.message;
    }

    if (errorMessage) {
      return callback(new Error('device spec validation failed, reason: ' + errorMessage));
    }

    //find all matching relatedStateVariable
    var serviceList = spec.device.serviceList;

    for (var serviceID in serviceList) {
      var service = serviceList[serviceID];
      var stateTable = service.serviceStateTable;
      var actionList = service.actionList;

      for (var actionName in actionList) {
        var action = actionList[actionName];

        if (options.allowSimpleType !== true) {
          if (Object.keys(action.argumentList).length > 2) {
            return callback(new Error('argumentList cannot contain arguments other than input and output. Service: ' + serviceID + ', action: ' + actionName));
          }
          if (action.argumentList.input == null) {
            return callback(new Error('missing input argument. Service: ' + serviceID + ', action: ' + actionName));
          }
          if (action.argumentList.output == null) {
            return callback(new Error('missing output argument. Service: ' + serviceID + ', action: ' + actionName));
          }
        }

        for (var argumentName in action.argumentList) {
          var argument          = action.argumentList[argumentName];
          var stateVariableName = argument.relatedStateVariable;
          var stateVariable     = stateTable[stateVariableName];

          if (stateVariable == null || typeof(stateVariable) !== 'object') {
            return callback(new Error('device spec validation failed, no matching state variable definition for service: ' + serviceID + ', action: ' + actionName + ', argument: ' + argumentName));
          }
          if (stateVariable.dataType !== 'object' && options.allowSimpleType !== true) {
            return callback(new Error('state variable dataType must be object. Service: ' + serviceID + ' State variable name: ' + stateVariableName));
          }
        }
      }
    }
    callback(null);
  }
};
