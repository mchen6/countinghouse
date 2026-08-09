var fs = require('fs');
var com_countinghouse_perfCalleeService_echoPayload = CHUtil.loadFile(__dirname + '/com-countinghouse-perfCalleeService-echoPayload.js');

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CHDevice.call(this, spec);
  this.setAction('urn:countinghouse-com:serviceID:perfCalleeService', 'echoPayload', com_countinghouse_perfCalleeService_echoPayload.bind(this));
}

CHUtil.inherits(Device, CHDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;
