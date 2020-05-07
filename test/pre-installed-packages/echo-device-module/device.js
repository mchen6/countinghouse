var fs = require('fs');
var echo = CdifUtil.loadFile(__dirname + '/echoService.js').echo;
var testTimeout = CdifUtil.loadFile(__dirname + '/timeOutTestService.js').testTimeout;

function Device() {
  var spec = JSON.parse(fs.readFileSync(__dirname + '/api.json').toString());
  CdifDevice.call(this, spec);
  this.setAction('urn:apemesh-com:serviceID:echoService', 'echo', echo.bind(this));
  this.setAction('urn:apemesh-com:serviceID:timeOutTestService', 'testTimeout', testTimeout.bind(this));
}

CdifUtil.inherits(Device, CdifDevice);

Device.prototype._getDeviceRootSchema = function() {
  return JSON.parse(fs.readFileSync(__dirname + '/schema.json').toString());
};

module.exports = Device;