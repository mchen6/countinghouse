var Session = require('./session');

function CdifClient(cdifInterface, userKey, deviceID, serviceID) {
  this.cdifInterface = cdifInterface;
  this.userKey = userKey;
  this.deviceID = deviceID;
  this.serviceID  = serviceID;
}


CdifClient.prototype.invoke = function(actionName, input, callback) {
  if (typeof(callback) !== 'function') return;
  // FIXME: this call will not be monitored by redis, should support it and add once support in callback
  var session = new Session(null, null, 'na', this.userKey, 0, this.deviceID, 0, callback);

  var args = {}; args.input = input;
  this.cdifInterface.invokeDeviceAction(this.deviceID, this.serviceID, actionName, args, null, session);
}

// let caller subscribe to the service events which can be emitted during run time
//TODO: emit service event to this client's subscribers
CdifClient.prototype.subscribe = function(callback) {

}

module.exports = CdifClient;