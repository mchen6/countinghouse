var ServiceClient  = require('./service-client');

function QueryDevice(appKey, cdifInterface, deviceID, serviceID, cb) {
  this.appKey    = appKey;
  this.ci        = cdifInterface;
  this.deviceID  = deviceID;
  this.serviceID = serviceID;
  this.cb        = cb;
  this.callback  = this.callback.bind(this);
}

QueryDevice.prototype.callback = function(error, cdifDevice) {
  if (error != null) return this.cb(new Error(error.message), null);
  return this.cb(null, new ServiceClient(this.ci, false, this.appKey, this.deviceID, this.serviceID));
}

module.exports = QueryDevice;