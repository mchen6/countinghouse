var ServiceClient  = require('./service-client');
var CdifDevice     = require('./cdif-device');

function QueryDevice(appKey, cdifInterface, deviceID, serviceID, cb) {
  this.appKey    = appKey;
  this.ci        = cdifInterface;
  this.deviceID  = deviceID;
  this.serviceID = serviceID;
  this.cb        = cb;
  this.callback  = this.callback.bind(this);
}


//TODO: do not use ci for service client under worker thread mode
QueryDevice.prototype.callback = function(error, cdifDevice) {
  if (error != null) return this.cb(new Error(error.message), null);

  var spec = null;

  if (cdifDevice instanceof CdifDevice) {
    spec = cdifDevice.spec;
  } else {
    //under worker thread mode cdifDevice would be spec itself
    spec = cdifDevice;
  }

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