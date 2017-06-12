var os          = require('os');
var util        = require('util');
var rewire      = require('rewire');
var request     = require('request');
var soap        = require('soap');
var CdifDevice  = require('cdif-device');
var LOG         = require('./logger');
var CdifError   = require('./cdif-error').CdifError;
var DeviceError = require('./cdif-error').DeviceError;

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
  }
};
