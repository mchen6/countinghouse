const ServiceClient  = require('./service-client');
const CHDevice     = require('./countinghouse-device');
const CHError      = require('./countinghouse-error').CHError;

function QueryDevice(appKey, cdifInterface, deviceID, serviceID, cb, billingKey) {
  this.appKey     = appKey;
  // who pays, when that differs from who is authorized -- see
  // lib/service-client.js's header
  this.billingKey = billingKey;
  this.ci        = cdifInterface;
  this.deviceID  = deviceID;
  this.serviceID = serviceID;
  this.cb        = cb;
  this.callback  = this.callback.bind(this);
}


QueryDevice.prototype.callback = function(error, cdifDevice) {
  if (error != null) return this.cb(new Error(error.message), null);

  let spec = null;

  if (cdifDevice instanceof CHDevice) {
    spec = cdifDevice.spec;
  } else {
    //under worker thread mode cdifDevice would be spec itself
    spec = cdifDevice;
  }

  if (spec == null) return this.cb(new CHError('NO_VALID_DEVICE_SPEC', this.deviceID));

  const serviceList = spec.device.serviceList;
  if (serviceList == null) return this.cb(new CHError('SERVICE_NOT_FOUND', this.serviceID));

  let found = false;
  for (const serviceID in serviceList) {
    if (serviceID === this.serviceID) found = true;
  }

  if (found == false) return this.cb(new CHError('SERVICE_NOT_FOUND', this.serviceID));

  if (cdifDevice instanceof CHDevice) {
    // non worker mode
    return this.cb(null, new ServiceClient(this.ci, false, false, this.appKey, this.deviceID, this.serviceID, this.billingKey));
  }
  //worker mode
  return this.cb(null, new ServiceClient(this.ci, false, true, this.appKey, this.deviceID, this.serviceID, this.billingKey));
};

module.exports = QueryDevice;