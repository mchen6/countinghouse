var Session   = require('./session');
var userAuth  = require('./user-auth');

function ServiceClient(cdifInterface, appKey, deviceID, serviceID) {
  this.cdifInterface = cdifInterface;
  this.appKey = appKey;
  this.deviceID = deviceID;
  this.serviceID  = serviceID;
}


ServiceClient.prototype.invoke = function(actionName, input, callback) {
  if (typeof(callback) !== 'function') return;

  //check the validness of appKey
  //get user's balance and apiRemainCount info from appKey to account this api call
  userAuth(null, null, this.deviceID, this.appKey, this.serviceID, actionName, callback, function(err, session) {
    if (err != null) return callback(err, null);
    //set localInput field so this call can be logged by redis
    session.localInput = input;

    var args = {}; args.input = input;
    this.cdifInterface.invokeDeviceAction(this.deviceID, this.serviceID, actionName, args, null, session);
  }.bind(this));
}

// let caller subscribe to the service events which can be emitted during run time
//TODO: emit service event to this client's subscribers
ServiceClient.prototype.subscribe = function(callback) {

}

module.exports = ServiceClient;