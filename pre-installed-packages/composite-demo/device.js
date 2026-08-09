var fs = require('fs');
var com_countinghouse_compositeService_run = CHUtil.loadFile(__dirname + '/com-countinghouse-compositeService-run.js');

// deviceIDs are deterministic (UUIDv5 of a fixed namespace + the target
// module's api.json friendlyName -- see lib/countinghouse-device.js's
// CHDevice constructor), so they can be computed offline rather than
// discovered at runtime. Mirrors the only other existing example of this
// pattern in the repo, pre-installed-packages/echo-device-client-module.
var ECHO_DEVICE_ID      = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767'; // echo-device-module ("echo-device")
var TRANSFORM_DEVICE_ID = 'a53ef5c7-cc2f-5264-9811-44f1611685ee'; // transform-demo

// Fixed demo identity for this module's own *internal* hops (the calls this
// module makes to echo-device-module/transform-demo on the caller's
// behalf) -- kept distinct from any real caller's apiKey so metering
// records produced by composition are easy to tell apart from direct
// calls during the demo. See docs/composite-tools.md for the caveat this
// implies: the outer MCP caller's own apiKey isn't threaded through to
// these inner hops in this demo.
var INTERNAL_API_KEY = 'composite-demo-internal';

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CHDevice.call(this, spec);

  this.setAction('urn:countinghouse-com:serviceID:compositeService', 'run', com_countinghouse_compositeService_run.bind(this));

  this.internalApiKey = INTERNAL_API_KEY;

  CHUtil.createServiceClient({
    deviceID:  TRANSFORM_DEVICE_ID,
    serviceID: 'urn:countinghouse-com:serviceID:transformService',
    appKey:    INTERNAL_API_KEY
  }, function(err, client) {
    if (err != null) return CHUtil.deviceLog(this, 'failed to create transform-demo service client: ' + err.message);
    this.transformClient = client;
  }.bind(this));

  CHUtil.createServiceClient({
    deviceID:  ECHO_DEVICE_ID,
    serviceID: 'urn:countinghouse-com:serviceID:echoService',
    appKey:    INTERNAL_API_KEY
  }, function(err, client) {
    if (err != null) return CHUtil.deviceLog(this, 'failed to create echo-device-module service client: ' + err.message);
    this.echoClient = client;
  }.bind(this));
}

CHUtil.inherits(Device, CHDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;
