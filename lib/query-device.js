'use strict';
const ServiceClient  = require('./service-client');
// lib/countinghouse-device.js's class, for an instanceof: on the main thread
// required, as it always was. A lean worker never holds one (the device
// model is the main thread's), so nothing there is a CHDevice, and loading
// it to ask would cost a worker's first hop the device model, the validator
// and its schema tooling (composition 18's #138-8). Which thread this is,
// taken as this file loads (a worker's boot, before module code), and
// require.cache never read: what module code put there decides nothing.
// Shared with lib/countinghouse-util.js.
// (a worker's answer is fixed then; the main thread's is read each time, so
// a test standing in for a worker there is seen, as lib/thread-info.js says)
const threadInfo = require('./thread-info');
const workerAtLoad = threadInfo.isMainThread !== true;
function chDeviceClass() {
  if (!workerAtLoad && threadInfo.isMainThread === true) return require('./countinghouse-device');
  return null;
}
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
// taken at load: a query holds the worker's interface, so it is built by
// definition and bound with what was here then (an assignment would run a
// setter module code put on Object.prototype, a bind module code put on
// Function.prototype, each with the query as `this`)
const FunctionBind = Function.prototype.call.bind(Function.prototype.bind);
const ObjectDefineProperty = Object.defineProperty;
const ObjectHasOwn = Object.hasOwn;
const own = (o, key, value) => ObjectDefineProperty(o, key, {__proto__: null, value: value, writable: true, enumerable: true, configurable: true});

function QueryDevice(appKey, cdifInterface, deviceID, serviceID, cb, billingKey) {
  own(this, 'appKey', appKey);
  // who pays, when that differs from who is authorized -- see
  // lib/service-client.js's header
  own(this, 'billingKey', billingKey);
  own(this, 'ci', cdifInterface);
  own(this, 'deviceID', deviceID);
  own(this, 'serviceID', serviceID);
  own(this, 'cb', cb);
  own(this, 'callback', FunctionBind(callbackOf, this));
}


QueryDevice.prototype.callback = function(error, cdifDevice) {
  // an error with a code (R2-1 Task 3: a missing device's reason, or the
  // access error, to an identity granted the device) is passed on as it is
  // (a worker's, issued where lean-worker decodes it)
  if (error != null) return this.cb((error != null && error.code != null) ? error : new Error(error.message), null);

  let spec = null;
  const CHDevice = chDeviceClass();
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

  // (the spec's own service, never one module code put on Object.prototype)
  const found = typeof(this.serviceID) === 'string' && ObjectHasOwn(serviceList, this.serviceID);

  if (found == false) return this.cb(new CountinghouseError('SERVICE_NOT_FOUND', this.serviceID));

  if (isDevice) {
    // non worker mode
    return this.cb(null, new ServiceClient(this.ci, false, false, this.appKey, this.deviceID, this.serviceID, this.billingKey));
  }
  //worker mode
  return this.cb(null, new ServiceClient(this.ci, false, true, this.appKey, this.deviceID, this.serviceID, this.billingKey));
};

// what each query's own callback is bound from (above), taken as this file loads
const callbackOf = QueryDevice.prototype.callback;

module.exports = QueryDevice;
// the CHDevice check, for lib/countinghouse-util.js too
QueryDevice.chDeviceClass = chDeviceClass;
