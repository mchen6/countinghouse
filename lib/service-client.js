var Session = require('./session');

function ServiceClient(cdifInterface, appKey, deviceID, serviceID) {
  this.cdifInterface = cdifInterface;
  this.appKey = appKey;
  this.deviceID = deviceID;
  this.serviceID  = serviceID;
}


ServiceClient.prototype.invoke = function(actionName, input, callback) {
  if (typeof(callback) !== 'function') return;
  // FIXME: this call will not be monitored by redis, should support it and add once support in callback
  // FIXME: query redis to construct the correct user info for session object

  // create a new session to handle this call, set its serviceID and actionName field manually
  // also set localInput field so this call can be logged by redis
  var session = new Session(null, null, 'na', this.appKey, 0, this.deviceID, 0, callback);
  session.serviceID  = this.serviceID;
  session.actionName = actionName;
  session.localInput = input;

  var args = {}; args.input = input;
  this.cdifInterface.invokeDeviceAction(this.deviceID, this.serviceID, actionName, args, null, session);
}

// let caller subscribe to the service events which can be emitted during run time
//TODO: emit service event to this client's subscribers
ServiceClient.prototype.subscribe = function(callback) {

}

module.exports = ServiceClient;