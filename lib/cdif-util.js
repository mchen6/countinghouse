var os             = require('os');
var util           = require('util');
var events         = require('events');
var rewire         = require('rewire');
var request        = require('request');
var soap           = require('soap');
var CdifDevice     = require('./cdif-device');
var LOG            = require('./logger');
var CdifError      = require('./cdif-error').CdifError;
var DeviceError    = require('./cdif-error').DeviceError;
var ServiceClient  = require('./service-client');

module.exports = {
  // if this host run as router it may need to return its WAN IP address
  getHostIp: function() {
    var interfaces = os.networkInterfaces();
    for (var k in interfaces) {
      for (var k2 in interfaces[k]) {
        var address = interfaces[k][k2];
          if (address.family === 'IPv4' && !address.internal) {
            // only return the first available IP
            return address.address;
          }
      }
    }
  },
  getHostProtocol: function() {
    // in production return https instead
    return 'http://';
  },

  inherits: function(constructor, superConstructor) {
    util.inherits(constructor, superConstructor);

    // prevent child override
    if (superConstructor === CdifDevice) {
      for (var i in superConstructor.prototype) {
        constructor.prototype[i] = superConstructor.prototype[i];
      }
    }
  },
  loadFile: function(name) {
    // avoid entering global require cache
    // to be used by device modules to reload its impl. files on module reload
    // name must be absolute path to the files
    try {
      return rewire(name);
    } catch (e) {
      LOG.E(new CdifError('LOAD_MODULE_FILE_FAIL', e.message));
      return null;
    }
  },
  request: function(options, callback) {
    //wrapper for request, https://www.npmjs.com/package/request
    request(options, callback);
  },
  createSOAPClient: function(url, options, callback) {
    //wrapper for SOAP client, https://www.npmjs.com/package/soap
    soap.createClient(url, options, callback);
  },
  invokeAction: function(userKey, deviceBaseUrl, serviceID, actionName, input, callback) {
    // convenience method to invoke a CDIF action
    var invokeUrl = deviceBaseUrl + '/invoke-action';
    var options = {
      url: invokeUrl,
      headers: {
        'X-Apemesh-Key': userKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json;charset=utf-8',
      },
      method: 'POST',
      json: {
        serviceID:  serviceID,
        actionName: actionName,
        input: input
      }
    };

    this.request(options, function(error, response, body) {
      if (error != null) {
        return callback(new DeviceError('SYSTEM_ERROR_NETWORK_ERROR'), {fault: {reason: error.message, info: ''}});
      }
      if (response.statusCode > 200) {
        return callback(new DeviceError('DATA_ERROR'), {fault: {reason: 'CDIF error response', info: body}});
      }
      return callback(null, body.output);
    });
  },
  // FIXME: how to identify if this is a local service and should not be accessible from outside?
  createServiceClient: function(options, callback) {
    var deviceID  = options.deviceID;
    var serviceID = options.serviceID;
    var appKey    = options.appKey || null;

    if (typeof(callback) !== 'function') return;
    if (appKey == null) return callback(new Error('must specify appKey'), null);
    // create a local invoke client
    // arguments: deviceID, serviceID, callback

    //client side api interface should become similar to above SOAP one:
    // CdifUtil.createClient(deviceID, serviceID, function(err, client) {
    //  client.invoke(actionName, input, callback);
    //  client.subscribe(function(data));  (listen to message from this service)
    // });

    // in a on-premise deployment environment we can safely assume the prefix of serviceIDs are all same for a device
    // so we can skip it. but the implementation of invokeAction should be able to safely detect any conflicts
    // e.g. different serviceID prefix with same name
    // var callee = null, key = null, baseUrl = null;
    // if (arguments.length < 2
    //   || (arguments.length === 2 && typeof(arguments[1]) !== 'function')
    //   || (arguments.length === 3 && typeof(arguments[2]) !== 'function')
    //   || (arguments.length === 4 && typeof(arguments[3]) !== 'function')
    // ) {
    //   return new Error('invalid input argument, signature must be deviceFriendlyName, optional-userKey, optional-cdifBaseURL, callback');
    // }
    // if (arguments.length === 2) {
    //   callee = arguments[1];
    // } else if (arguments.length === 3) {
    //   // we assume cdifBaseUrl must begin with 'http'
    //   if (/^http./.test(arguments[1]) === true) {
    //     baseUrl = arguments[1];
    //   } else {
    //     key = arguments[1];
    //   }
    //   callee = arguments[2];
    // } else {
    //   key     = arguments[1];
    //   baseUrl = arguments[2];
    //   callee  = arguments[3];
    // }
    if (deviceID == null || serviceID == null || typeof(deviceID) !== 'string' || typeof(serviceID) !== 'string') return callback(new Error('must specify deviceID and serviceID'), null);

    this.dm.emit('querydevice', deviceID, function(error, cdifDevice) {
      if (error != null) return callback(new Error(error.message), null);
      return callback(null, new ServiceClient(this.ci, appKey, deviceID, serviceID));
    }.bind(this));
  }
  //TODO: add message broadcast support,
  // such as: broadCastMessage(data);
};
