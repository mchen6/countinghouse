var fs = require('fs');
var com_countinghouse_perfCallerService_run = CHUtil.loadFile(__dirname + '/com-countinghouse-perfCallerService-run.js');

// deterministic, computed offline via UUID.v5 -- see
// pre-installed-packages/composite-demo/device.js for the same pattern.
var CALLEE_DEVICE_ID = 'fb9fbd3d-5860-538e-b0b7-9f5e34389577'; // perf-callee-demo

var INTERNAL_API_KEY = 'perf-caller-demo-internal';

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CHDevice.call(this, spec);

  this.setAction('urn:countinghouse-com:serviceID:perfCallerService', 'run', com_countinghouse_perfCallerService_run.bind(this));

  CHUtil.createServiceClient({
    deviceID:  CALLEE_DEVICE_ID,
    serviceID: 'urn:countinghouse-com:serviceID:perfCalleeService',
    appKey:    INTERNAL_API_KEY
  }, function(err, client) {
    if (err != null) return CHUtil.deviceLog(this, 'failed to create perf-callee-demo service client: ' + err.message);
    this.calleeClient = client;
  }.bind(this));
}

CHUtil.inherits(Device, CHDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;
