var events        = require('events');
var util          = require('util');
var isMainThread  = require('worker_threads').isMainThread;
var options       = require('./cli-options');
var DeviceManager = require('./device-manager');
var LOG           = require('./logger');
var cdifUtil      = require('./cdif-util');

function CdifInterface(mm) {
  this.deviceManager = new DeviceManager(mm);

  // set dm to cdif util instance
  cdifUtil.dm = this.deviceManager;
  cdifUtil.ci = this;

  if (options.heapDump === true) {
    setInterval(function() {
      global.gc();
      LOG.I('heap used: ' + process.memoryUsage().heapUsed);
      // heapdump.writeSnapshot('./' + Date.now() + '.heapsnapshot');
    }, 1 * 60 * 1000);
  }

  if (options.loadProfile === true && isMainThread === true) {
    this.lastMinuteLoadLevel = 0;
    this.loadLevel = 0;
    setInterval(function() {
      this.lastMinuteLoadLevel = this.loadLevel;
      LOG.I('requests in last 10 minutes: ' + this.loadLevel);
      this.loadLevel = 0;
    }.bind(this), 10 * 60 * 1000);
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

CdifInterface.prototype.invokeDeviceAction = function(deviceID, serviceID, actionName, args, token, session) {
  if (options.loadProfile === true) this.loadLevel ++;
  this.deviceManager.emit('invokeaction', deviceID, serviceID, actionName, args, token, session);
};

CdifInterface.prototype.getDeviceSpec = function(deviceID, token, session) {
  if (options.loadProfile === true) this.loadLevel ++;
  this.deviceManager.emit('getspec', deviceID, token, session);
};

CdifInterface.prototype.getDeviceState = function(deviceID, serviceID, token, session) {
  this.deviceManager.emit('devicestate', deviceID, serviceID, token, session);
};

CdifInterface.prototype.eventSubscribe = function(deviceID, serviceID, actionName, input, inputKey, token, callback) {
  this.deviceManager.emit('subscribe', deviceID, serviceID, actionName, input, inputKey, token, callback);
};

CdifInterface.prototype.eventUnsubscribe = function(deviceID, serviceID, actionName, input, inputKey, token, callback) {
  this.deviceManager.emit('unsubscribe', deviceID, serviceID, actionName, input, inputKey, token, callback);
};

CdifInterface.prototype.getDeviceSchema = function(deviceID, path, token, session) {
  if (options.loadProfile === true) this.loadLevel ++;
  this.deviceManager.emit('getschema', deviceID, path, token, session);
};

CdifInterface.prototype.invokeDeviceCallbacks = function(deviceID, path, data, token, session) {
  this.deviceManager.emit('invokecallback', deviceID, path, data, token, session);
};

CdifInterface.prototype.onDevicePresentation = function(deviceID) {
  this.emit('presentation', deviceID);
};

//For now we ignore interval argument
CdifInterface.prototype.getServerLoadLevel = function(interval, callback) {
  callback(null, this.lastMinuteLoadLevel);
};

module.exports = CdifInterface;
