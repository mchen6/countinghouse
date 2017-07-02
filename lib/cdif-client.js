var Session = require('./session');

function CdifClient(cdifInterface, deviceID, serviceID) {
  this.cdifInterface = cdifInterface;
  this.deviceID = deviceID;
  this.serviceID  = serviceID;
  this.session = new Session(req, res, 'na', userKey, 0, deviceObj.deviceID, 0);
}


CdifClient.prototype.invoke = function(actionName, input, callback) {
  if (typeof(callback) !== 'function') return;
  this.session.callback = callback; // hack session callback
  // FIXME: this call will not be monitored by redis
  var args = {}; args.input = input;
  this.cdifInterface.invokeDeviceAction(this.deviceID, this.serviceID, actionName, args, null, session);
}

// let caller subscribe to the service events which can be emitted during run time
//TODO: emit service event to this client's subscribers
CdifClient.prototype.subscribe = function(callback) {

}

module.exports = CdifClient;