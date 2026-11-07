// Whether a stored module output still conforms to an output schema, checked
// with the runtime's own ajv instance (lib/validator.js) -- the one
// validateActionCall uses -- so "conforms" means the same in both places.
// tasks/result uses it for a result stored before a reload.
const validator = require('../validator');

// ajv keeps every schema object it compiles, keyed by the object, and each
// tasks/result read brings a freshly resolved one: without removeSchema the
// shared main-thread instance would grow by one compiled validator per read,
// and a schema with an $id would throw "already exists" from the second read.
// Only a schema this check compiled is removed: when compile throws, the $id
// is someone else's registration (in single-thread mode the runtime compiles
// module schemas on this same instance), and removeSchema(object) would drop
// it by $id.
function outputConforms(schema, output) {
  const ajv = validator.getSchemaValidator();
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (e) {
    return false;
  }
  try {
    return validate(output) === true;
  } finally {
    ajv.removeSchema(schema);
  }
}

module.exports = {outputConforms};
