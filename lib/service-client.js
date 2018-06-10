var events      = require('events');
var util        = require('util');
var Session   = require('./session');
var userAuth  = require('./user-auth');
var request   = require('request');

function ServiceClient(cdifInterface, isRemoteService, appKey, deviceID, serviceID) {
  this.cdifInterface = cdifInterface;
  this.isRemote = isRemoteService;
  this.appKey = appKey;
  this.deviceID = deviceID;
  this.serviceID  = serviceID;
  this.invoke = this.invoke.bind(this);
  this.deviceBaseUrl = null;
}

util.inherits(ServiceClient, events.EventEmitter);

//TODO: add client.on('servicedown', function() {...}) support

// ServiceClient.prototype.invoke = function(actionName, args, callback) {
ServiceClient.prototype.invoke = function(opts, callback) {
  if (typeof(callback) !== 'function')      return;
  if (typeof(opts) !== 'object')            return callback(new Error('opts must be object'));
  if (opts.actionName == null)              return callback(new Error('must specify actionName'));
  if (typeof(opts.actionName) !== 'string') return callback(new Error('actionName must be string'));
  if (opts.input == null)                   return callback(new Error('must specify input argument'));

  if (this.isRemote === true) {
    var opts = {
      url: this.deviceBaseUrl + '/invoke-action',
      headers: {
        'X-Apemesh-Key': this.appKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json;charset=utf-8',
      },
      method: 'POST',
      json: {
        serviceID:  this.serviceID,
        actionName: opts.actionName,
        input: opts.input
      }
    };
    //TODO: add request timeout support
    request(opts, function(error, response, body) {
      if (error != null) {
        return callback(error, null);
      }
      if (response.statusCode > 200) {
        return callback(new Error(body.message), null);
      }
      //body contain parsed JSON data with output field in it
      return callback(null, body);
    });
  } else {
    //check the validness of appKey
    //get user's balance and apiRemainCount info from appKey to account this api call
    userAuth(null, null, this.deviceID, this.appKey, this.serviceID, opts.actionName, callback, function(err, session) {
      if (err != null) return callback(err, null);
      var args = {input: opts.input};
      //set localInput field so this call can be logged by redis
      session.localInput = args;

      // var args = {}; args.input = input;
      this.cdifInterface.invokeDeviceAction(this.deviceID, this.serviceID, opts.actionName, args, null, session);
    }.bind(this));
  }
}

// let caller subscribe to the service events which can be emitted during run time
//TODO: emit service event to this client's subscribers
ServiceClient.prototype.subscribe = function(callback) {

}

module.exports = ServiceClient;