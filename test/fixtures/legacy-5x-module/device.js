var fs = require('fs');
// ES5 spelling on purpose: this is what a real 5.x module in the wild looks
// like, and it is the spelling the migrator originally failed to match.
var com_countinghouse_legacyService_shout = CHUtil.loadFile(__dirname + '/com-countinghouse-legacyService-shout.js');

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CHDevice.call(this, spec);
  this.setAction('urn:countinghouse-test:serviceID:legacyService', 'shout', com_countinghouse_legacyService_shout.bind(this));
}

CHUtil.inherits(Device, CHDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;
