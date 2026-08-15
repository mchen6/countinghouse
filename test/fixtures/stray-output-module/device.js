// Fixture for test/validation/02-stray-output-rejected.js.
var fs = require('fs');
function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CHDevice.call(this, spec);
  this.setAction('urn:countinghouse-test:serviceID:svc', 'returnsStrayKey', function(args, callback) {
    // the declared output, plus an argument the spec knows nothing about
    return callback(null, {output: {v: args.input.v}, surprise: 'undeclared'});
  }.bind(this));
  this.setAction('urn:countinghouse-test:serviceID:svc', 'returnsCleanly', function(args, callback) {
    return callback(null, {output: {v: args.input.v}});
  }.bind(this));
}
CHUtil.inherits(Device, CHDevice);
Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};
module.exports = Device;
