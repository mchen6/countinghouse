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
  var spec = cdifDevice.spec;
  if (spec == null) return this.cb(new Error('查找服务失败，应用无规范'));

  var serviceList = spec.device.serviceList;
  if (serviceList == null) return this.cb(new Error('查找服务失败，应用内无对应服务'));

  var found = false;
  for (var serviceID in serviceList) {
    if (serviceID === this.serviceID) found = true;
  }

  if (found === true) return this.cb(null, new ServiceClient(this.ci, false, this.appKey, this.deviceID, this.serviceID));
  return this.cb(new Error('查找服务失败，应用内无对应服务'));
}

module.exports = QueryDevice;