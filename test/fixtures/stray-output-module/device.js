// Fixture for test/validation/02-stray-output-rejected.js.
const fs = require('fs');
function Device() {
  const spec = JSON.parse(fs.readFileSync(`${__dirname}/api.json`).toString());
  CHDevice.call(this, spec);
  this.setAction('urn:countinghouse-test:serviceID:svc', 'returnsStrayKey', (args, callback) => {
    // the declared output, plus an argument the spec knows nothing about
    return callback(null, {output: {v: args.input.v}, surprise: 'undeclared'});
  });
  this.setAction('urn:countinghouse-test:serviceID:svc', 'returnsCleanly', (args, callback) => {
    return callback(null, {output: {v: args.input.v}});
  });
}
CHUtil.inherits(Device, CHDevice);
Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(`${__dirname}/schema.json`).toString());
};
module.exports = Device;
