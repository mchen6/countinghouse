var events      = require('events');
var util        = require('util');

var options       = require('./cli-options');
var DeviceManager = require('./device-manager');
var LOG           = require('./logger');

function CdifInterface(mm) {
  this.deviceManager = new DeviceManager(mm);

  if (options.heapDump === true) {
    setInterval(function() {
      global.gc();
      LOG.I('heap used: ' + process.memoryUsage().heapUsed);
      // heapdump.writeSnapshot('./' + Date.now() + '.heapsnapshot');
    }, 1 * 60 * 1000);
  }

  this.deviceManager.on('presentation', this.onDevicePresentation.bind(this));
}

util.inherits(CdifInterface, events.EventEmitter);

CdifInterface.prototype.discoverAll = function(session) {
  this.deviceManager.emit('discoverall', session);
};

CdifInterface.prototype.stopDiscoverAll = function(session) {
  this.deviceManager.emit('stopdiscoverall', session);
};

CdifInterface.prototype.getDiscoveredDeviceList = function(session) {
  this.deviceManager.emit('devicelist', session);
};

CdifInterface.prototype.connectDevice = function(deviceID, user, pass, session) {
  this.deviceManager.emit('connect', deviceID, user, pass, session);
};

CdifInterface.prototype.disconnectDevice = function(deviceID, token, session) {
  this.deviceManager.emit('disconnect', deviceID, token, session);
};

CdifInterface.prototype.invokeDeviceAction = function(deviceID, serviceID, actionName, args, token, session) {
  this.deviceManager.emit('invokeaction', deviceID, serviceID, actionName, args, token, session);
};

CdifInterface.prototype.getDeviceSpec = function(deviceID, token, session) {
  this.deviceManager.emit('getspec', deviceID, token, session);
};

CdifInterface.prototype.getDeviceState = function(deviceID, serviceID, token, session) {
  this.deviceManager.emit('devicestate', deviceID, serviceID, token, session);
};

CdifInterface.prototype.eventSubscribe = function(subscriber, deviceID, serviceID, actionName, input, inputKey, token, callback) {
  this.deviceManager.emit('subscribe', subscriber, deviceID, serviceID, actionName, input, inputKey, token, callback);
};

CdifInterface.prototype.eventUnsubscribe = function(subscriber, deviceID, serviceID, actionName, input, inputKey, token, callback) {
  this.deviceManager.emit('unsubscribe', subscriber, deviceID, serviceID, actionName, input, inputKey, token, callback);
};

CdifInterface.prototype.getDeviceSchema = function(deviceID, path, token, session) {
  this.deviceManager.emit('getschema', deviceID, path, token, session);
};

CdifInterface.prototype.setDeviceOAuthAccessToken = function(deviceID, params, session) {
  this.deviceManager.emit('setoauthtoken', deviceID, params, session);
};

CdifInterface.prototype.invokeDeviceCallbacks = function(deviceID, path, data, token, session) {
  this.deviceManager.emit('invokecallback', deviceID, path, data, token, session);
};

CdifInterface.prototype.getDeviceRootUrl = function(deviceID, session) {
  this.deviceManager.emit('getrooturl', deviceID, session);
};

CdifInterface.prototype.onDevicePresentation = function(deviceID) {
  this.emit('presentation', deviceID);
};

module.exports = CdifInterface;
