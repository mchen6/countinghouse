const options               = require('../lib/cli-options');
const Ajv2020                = require('ajv/dist/2020');
const addFormats             = require('ajv-formats');
const ajv                    = new Ajv2020({allErrors: false, allowUnionTypes: true});
addFormats(ajv);
const deviceRootSchema      = require('../spec/schema.json');
const deviceSchemaValidator = ajv.compile(deviceRootSchema);
const pointer               = require('json-pointer');


module.exports = {
  getSchemaValidator: function() {
    return ajv;
  },

  // `schemaObj` is an action's resolved input/output/fault object:
  // {schema: <dereferenced schema document>, validator: <compiled ajv validator>}.
  //
  // The dataType / allowedValueRange / allowedValueList switch this used to
  // run was removed in 5.0.0 along with the state table that carried them:
  // every argument is a JSON Schema document, and a scalar constraint is
  // expressed in that schema rather than beside it. (--allowSimpleType, the
  // flag that let a non-object argument through at all, was already gone.)
  validate: function(name, schemaObj, data, callback) {
    let errorMessage = null;
    let errorInfo    = null;

    if (data === null) {
      errorMessage = 'empty data'; errorInfo = name;
    } else if (typeof(data) !== 'object' && !Array.isArray(data)) {
      errorMessage = 'data is not of type object'; errorInfo = name;
    } else {
      const schema = schemaObj.schema;
      if (schema == null) {   // check both null and undefined
        errorMessage = 'data has no schema object'; errorInfo = name;
      } else if (typeof(schema) !== 'object') {
        // still a pointer string: the schema.json subtree it names could not be resolved
        errorMessage = 'data schema object is invalid'; errorInfo = name;
      } else {
        const validator = schemaObj.validator;
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

  // Reports *where* a spec failed, not just that it did. ajv gives each error
  // an `instancePath` (a JSON pointer into the spec being validated) alongside
  // `message`; reporting only errors[0].message -- which is what this used to
  // do -- produces things like "must have required property 'input'" with no
  // way to tell which of a module's actions is missing it. Every error is
  // reported, not just the first, so one pass over the log is enough to fix
  // the whole spec instead of one property per restart.
  //
  // The structured list is also attached to the returned Error as
  // `.validationErrors` ([{instancePath, message, schemaPath}]) so callers can
  // format it themselves rather than re-parse the message string.
  // A pre-5.0.0 spec fails the meta-schema, but with errors that describe the
  // symptom ("actionList must be array", "must NOT have additional properties")
  // rather than the cause, and with no hint that a converter exists. Detecting
  // the old shape explicitly turns that into one actionable sentence. Presence
  // of serviceStateTable is the primary tell, per the format's own history.
  detectLegacySpec: function(spec) {
    if (spec == null || typeof(spec) !== 'object') return null;

    // structural tells first: they point at the part the author has to rewrite
    const serviceList = (spec.device != null) ? spec.device.serviceList : null;
    for (const serviceID in serviceList) {
      if (serviceList[serviceID].serviceStateTable != null) {
        return `a serviceStateTable in service ${serviceID}`;
      }
      if (serviceList[serviceID].actionList != null && !Array.isArray(serviceList[serviceID].actionList)) {
        return `an object actionList (5.0.0 expects an array) in service ${serviceID}`;
      }
    }

    if (spec.specVersion != null) return 'a top-level specVersion';
    if (spec.configId != null)    return 'a top-level configId';
    return null;
  },

  validateDeviceSpec: function(spec, callback) {
    let errorMessage     = null;
    let validationErrors = null;

    const legacy = this.detectLegacySpec(spec);
    if (legacy != null) {
      return callback(new Error(`this api.json is in the pre-5.0.0 spec format (found ${legacy
                                }). Convert it with: npx countinghouse-migrate-spec <module directory> ` +
                                `-- see MIGRATION.md for what changes.`));
    }

    try {
      if (!deviceSchemaValidator(spec)) {
        validationErrors = (deviceSchemaValidator.errors || []).map((e) => {
          return {
            instancePath: (e.instancePath != null && e.instancePath !== '') ? e.instancePath : '(root)',
            message:      e.message,
            schemaPath:   e.schemaPath
          };
        });
        errorMessage = validationErrors.map((e) => {
          return `${e.instancePath}: ${e.message}`;
        }).join('; ');
      }
    } catch (e) {
      errorMessage = e.message;
    }

    if (errorMessage) {
      const err = new Error(errorMessage);
      if (validationErrors != null) err.validationErrors = validationErrors;
      return callback(err);
    }

    // Action names are unique per service. The meta-schema cannot express this
    // now that actionList is an array (it was implicit when actions were object
    // keys), and a duplicate would silently shadow the first definition at load
    // time, so it is checked here.
    const serviceList = spec.device.serviceList;

    for (const serviceID in serviceList) {
      const actionList = serviceList[serviceID].actionList;
      const seen       = {};

      for (let i = 0; i < actionList.length; i++) {
        const actionName = actionList[i].name;

        if (seen[actionName] === true) {
          return callback(new Error(`duplicate action name. Service: ${serviceID}, action: ${actionName}`));
        }
        seen[actionName] = true;
      }
    }
    callback(null);
  }
};
