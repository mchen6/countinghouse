var options               = require('../lib/cli-options');
var Ajv2020                = require('ajv/dist/2020');
var addFormats             = require('ajv-formats');
var ajv                    = new Ajv2020({allErrors: false, allowUnionTypes: true});
addFormats(ajv);
var deviceRootSchema      = require('../spec/schema.json');
var deviceSchemaValidator = ajv.compile(deviceRootSchema);
var pointer               = require('json-pointer');


module.exports = {
  getSchemaValidator: function() {
    return ajv;
  },

  validate: function(name, varDef, data, callback) {
    var type  = varDef.dataType;
    var range = varDef.allowedValueRange;
    var list  = varDef.allowedValueList;

    var errorMessage = null;
    var errorInfo    = null;

    if (type == null) {  //check null and undefined
      errorMessage = 'invalid variable type'; errorInfo = name;
    }
    if (data === null) {
      errorMessage = 'empty data'; errorInfo = name;
    }
    if (errorMessage === null) {
      switch (type) {
        case 'number':
          if (typeof(data) !== 'number') {
            errorMessage = 'data is not of type number'; errorInfo = name;
          }
          break;
        case 'integer':
          if (typeof(data) !== 'number' || (data % 1) !== 0) {
            errorMessage = 'data is not of type integer'; errorInfo = name;
          }
          break;
        case 'string':
          if (typeof(data) !== 'string') {
            errorMessage = 'data is not of type string'; errorInfo = name;
          }
          break;
        case 'boolean':
          if (typeof(data) !== 'boolean') {
            errorMessage = 'data is not of type boolean'; errorInfo = name;
          }
          break;
        case 'object':
          if (typeof(data) !== 'object' && !Array.isArray(data)) {
            errorMessage = 'data is not of type object'; errorInfo = name;
          } else {
            var schema = varDef.schema;
            if (schema == null) {   // check both null and undefined
              errorMessage = 'data has no schema object'; errorInfo = name;
            } else if (typeof(schema) !== 'object') {
              errorMessage = 'data schema object is invalid'; errorInfo = name;
            } else {
              var validator = varDef.validator;
              if (validator == null) {
                errorMessage = 'schema validator unavailable'; errorInfo = name;
              } else {
                try {
                  if (!validator(data)) {
                    errorMessage = 'data validation failed';
                    errorInfo    = this.getValidatorErrorInfo(validator.errors[0]);
                  }
                } catch (e) {
                  errorMessage = 'data validation threw'; errorInfo = name + e.message;
                }
              }
            }
          }
          break;
        default:
          errorMessage = 'data validation failed'; errorInfo = name + 'unknown data type: ' + type;
          break;
      }
    }
    if (errorMessage === null) {
      if (range) {
        if (data > range.maximum || data < range.minimum) {
          errorMessage = 'data out of allowed range'; errorInfo = name;
        }
      }
      if (list) {
        var matched = false;
        for (var i in list) {
          if (data === list[i]) matched = true;
        }
        if (matched === false) {
          errorMessage = 'data not in allowed value list'; errorInfo = name;
        }
      }
    }
    callback(errorMessage, errorInfo);
  },

  getValidatorErrorInfo: function(error) {
    // console.log(schema);
    // console.log(data);
    // console.log(error);

    // ajv 8 renamed error.dataPath to error.instancePath; keep the response field
    // named dataPath since it's part of this framework's API contract
    return {dataPath: error.instancePath, schemaPath: error.schemaPath, validatorMessage: error.message};
    // var path = error.dataPath;

    // if (path != null && path !== '') {
    //   //TODO: add array and other type support
    //   if (schema.type === 'object') {
    //     var p = '/properties' + path + '/title';
    //     var title = pointer.get(schema, p);
    //     if (title != null) {
    //       return pointer.get(schema, p) + '格式错误';
    //     }
    //   }
    // }
    // return null;
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
