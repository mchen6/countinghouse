const ServiceClient  = require('./service-client');
// lib/countinghouse-device.js's class, if this thread has loaded it. A lean
// worker never does (the device model is the main thread's), so nothing
// there is a CHDevice; loading it to ask would cost a worker's first hop the
// device model, the validator and its schema tooling (composition 18's
// #138-8). The main thread has it loaded before any device exists.
const CHDEVICE_PATH = require.resolve('./countinghouse-device');
const loadedCHDevice = () => { const m = require.cache[CHDEVICE_PATH]; return (m != null) ? m.exports : null; };
const CountinghouseError = require('./countinghouse-error').CountinghouseError;

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
  // an error with a code (R2-1 Task 3: a missing device's reason, or the
  // access error, to an identity granted the device) is passed on as it is
  if (error != null) return this.cb((error != null && error.code != null) ? error : new Error(error.message), null);

  let spec = null;
  const CHDevice = loadedCHDevice();
  const isDevice = (CHDevice != null && cdifDevice instanceof CHDevice);

  if (isDevice) {
    spec = cdifDevice.spec;
  } else {
    //under worker thread mode cdifDevice would be spec itself
    spec = cdifDevice;
  }

  if (spec == null) return this.cb(new CountinghouseError('NO_VALID_DEVICE_SPEC', this.deviceID));

  const serviceList = spec.device.serviceList;
  if (serviceList == null) return this.cb(new CountinghouseError('SERVICE_NOT_FOUND', this.serviceID));

  let found = false;
  for (const serviceID in serviceList) {
    if (serviceID === this.serviceID) found = true;
  }

  if (found == false) return this.cb(new CountinghouseError('SERVICE_NOT_FOUND', this.serviceID));

  if (isDevice) {
    // non worker mode
    return this.cb(null, new ServiceClient(this.ci, false, false, this.appKey, this.deviceID, this.serviceID, this.billingKey));
  }
  //worker mode
  return this.cb(null, new ServiceClient(this.ci, false, true, this.appKey, this.deviceID, this.serviceID, this.billingKey));
};

module.exports = QueryDevice;