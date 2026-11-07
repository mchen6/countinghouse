// A fingerprint of an output schema, so tasks/result can tell whether the
// schema advertised now is the one a stored result was produced under
// without compiling the module's schema on the main thread. Object keys are
// sorted at every depth (two schemas differing only in key order are the
// same schema); array order is kept, since it can matter (prefixItems).
const crypto = require('crypto');

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof(value) === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function outputSchemaHash(schema) {
  if (schema == null) return null;
  return crypto.createHash('sha256').update(canonicalJSON(schema)).digest('hex');
}

module.exports = {canonicalJSON, outputSchemaHash};
