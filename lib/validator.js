'use strict';
const options               = require('../lib/cli-options');
const Ajv2020                = require('ajv/dist/2020');
const addFormats             = require('ajv-formats');
const ajv                    = new Ajv2020({allErrors: false, allowUnionTypes: true});
addFormats(ajv);
assertBase64(ajv);
const deviceRootSchema      = require('../spec/schema.json');
const deviceSchemaValidator = ajv.compile(deviceRootSchema);
const pointer               = require('json-pointer');

// Canonical RFC 4648 base64 (MCP completeness, spec section 1): the standard
// alphabet, padded to a multiple of 4, no whitespace, and zero pad bits, so
// each byte string has exactly one spelling. Checked without one anchored
// regex: a backtracking loop over a 16 MiB string risks irregexp's
// backtrack stack. One search for a character outside the alphabet (and
// '='), then the padding by hand. '' is the empty bytes' spelling.
function isCanonicalBase64(s) {
  const n = s.length;
  if (n % 4 !== 0) return false;
  if (n === 0) return true;
  if (/[^A-Za-z0-9+/=]/.test(s)) return false;
  const pads = s.charCodeAt(n - 1) !== 61 ? 0 : (s.charCodeAt(n - 2) !== 61 ? 1 : 2);
  const eq = s.indexOf('=');
  if (eq !== -1 && eq !== n - pads) return false;
  // the bits after the last byte, in the character before the padding, are 0
  if (pads === 2) return 'AQgw'.includes(s[n - 3]);
  if (pads === 1) return 'AEIMQUYcgkosw048'.includes(s[n - 2]);
  return true;
}

// contentEncoding "base64" as an assertion in an ajv instance (ajv's own
// keyword, in its metadata vocabulary, asserts nothing). For strings only, as
// the keyword is; any other encoding stays an annotation. Both instances get
// it (the shared one, which single-thread mode compiles with, and each
// validator worker's), so it holds on every path: tools/call, a hop,
// invoke-action, a job; inputs and outputs alike.
function assertBase64(instance) {
  instance.removeKeyword('contentEncoding');
  // no `type` in the definition: ajv's strictTypes would warn for every
  // schema using the keyword without naming type: string; the non-string
  // case is checked here instead
  instance.addKeyword({
    keyword: 'contentEncoding',
    schemaType: 'string',
    errors: true,
    validate: function contentEncoding(encoding, data) {
      if (encoding !== 'base64' || typeof(data) !== 'string' || isCanonicalBase64(data)) return true;
      contentEncoding.errors = [{keyword: 'contentEncoding', params: {contentEncoding: 'base64'},
        message: 'must be canonical base64 (RFC 4648: the standard alphabet, padded, no whitespace)'}];
      return false;
    }
  });
}


module.exports = {
  isCanonicalBase64: isCanonicalBase64,

  getSchemaValidator: function() {
    return ajv;
  },

  // A fresh instance with the same options, for one module's schemas on the
  // validator worker (lib/validator-worker.js): a schema's $id is registered in the
  // instance that compiles it, so one shared instance would refuse the same
  // absolute $id at the module's next start, or from another module, and
  // would keep every module's compiled validators for good. Each worker has
  // had its own instance all along.
  // opts.logger: ajv's logger (lib/validator-worker.js bounds it).
  // A new instance compiles the 2020-12 meta-schema to check each schema
  // against, 50 to 175 ms, before its first compile; done for every module,
  // that is a module's first check (lean worker step 1(b): under a
  // deadline). So the meta-schema check is this module's shared instance's,
  // compiled once per thread, with the error ajv itself throws; the new
  // instance compiles without it.
  createSchemaValidator: function(opts) {
    const own = new Ajv2020(Object.assign({allErrors: false, allowUnionTypes: true, validateSchema: false},
      (opts != null && opts.logger != null) ? {logger: opts.logger} : {}));
    addFormats(own);
    assertBase64(own);
    const compile = own.compile.bind(own);
    own.compile = function(schema, meta) {
      if (!ajv.validateSchema(schema)) throw new Error(`schema is invalid: ${ajv.errorsText(ajv.errors)}`);
      return compile(schema, meta);
    };
    return own;
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

    // an output may be any JSON value, null included, which its schema
    // checks (MCP completeness M20: structuredContent of any type); an input
    // is an object, as MCP's arguments are
    const anyValue = name === 'output';
    if (!anyValue && data === null) {
      errorMessage = 'empty data'; errorInfo = name;
    } else if (!anyValue && typeof(data) !== 'object') {
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
    //       return pointer.get(schema, p) + ' is malformed';
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
