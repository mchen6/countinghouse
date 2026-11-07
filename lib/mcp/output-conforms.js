// Whether a stored module output still conforms to an output schema, checked
// with the runtime's own ajv instance (lib/validator.js) -- the one
// validateActionCall uses -- so "conforms" means the same in both places.
// tasks/result uses it for a result stored before a reload.
const validator = require('../validator');

// ajv keeps every schema object it compiles, keyed by the object, and each
// tasks/result read brings a freshly resolved one: without removeSchema the
// shared main-thread instance would grow by one compiled validator per read,
// and a schema with an $id would throw "already exists" from the second read.
function outputConforms(schema, output) {
  const ajv = validator.getSchemaValidator();
  try {
    return ajv.compile(schema)(output) === true;
  } catch (e) {
    return false;
  } finally {
    try { ajv.removeSchema(schema); } catch (e) { /* never added */ }
  }
}

module.exports = {outputConforms};
